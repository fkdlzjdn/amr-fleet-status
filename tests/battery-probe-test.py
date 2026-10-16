import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import time
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('battery_probe', Path(__file__).parents[1] / 'lib/battery-probe.py')
battery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(battery)


class BatteryProbeTests(unittest.TestCase):
    def test_topic_identity_and_multiple_sources(self):
        def topics(*names):
            return [(name, ['sensor_msgs/msg/BatteryState']) for name in names]
        self.assertEqual(battery.battery_topic(topics('/R_006/bms_node/battery_state', '/R_007/battery_state'), 'R_006'),
                         ('/R_006/bms_node/battery_state', None))
        for names, rid, reason in [
            (('/R_007/battery_state',), 'R_006', 'no_topic'),
            (('/R_006/battery_state',), None, 'identity_unknown'),
            (('/battery_state', '/bms_node/battery_state'), None, 'ambiguous'),
        ]:
            self.assertEqual(battery.battery_topic(topics(*names), rid), (None, reason))
        self.assertEqual(battery.battery_topic([('/battery_state', ['std_msgs/Float32'])], None), (None, 'no_topic'))

    def test_sample_freshness_presence_and_invalid_values(self):
        values = {'percentage': 0.0, 'present': True, 'current': float('nan')}
        result = battery.battery_sample(values, '/battery_state', 'ros1', time.time())
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['percentage'], 0)
        self.assertIsNone(result['current'])
        json.dumps(result, allow_nan=False)
        self.assertEqual(battery.battery_sample(values, '/battery_state', 'ros1', time.time() - 100)['status'], 'stale')
        self.assertEqual(battery.battery_sample(values, '/battery_state', 'ros1', 0, latched=True)['status'], 'stale')
        self.assertEqual(battery.battery_sample(dict(values, present=False), '/battery_state', 'ros2')['status'], 'not_present')
        for value in (None, -1, 70, float('nan')):
            self.assertEqual(battery.battery_sample(dict(values, percentage=value), '/battery_state', 'ros1')['status'], 'invalid')

    def test_ros1_tcpros_melodic_and_noetic_without_ros_modules(self):
        # Test actual wire framing, optional temperature field and fragmented reads.
        for temperature in (False, True):
            definition = 'Header header\nfloat32 voltage\n' + ('float32 temperature\n' if temperature else '')
            definition += 'float32 current\nfloat32 charge\nfloat32 capacity\nfloat32 design_capacity\nfloat32 percentage\nuint8 power_supply_status\nuint8 power_supply_health\nuint8 power_supply_technology\nbool present\nfloat32[] cell_voltage\n'
            def frame(data):
                return struct.pack('<I', len(data)) + data
            header = {'type': 'sensor_msgs/BatteryState', 'message_definition': definition, 'latching': '0'}
            body = struct.pack('<IIII', 1, int(time.time()), 0, 3) + b'bms'
            floats = [51.2] + ([24.0] if temperature else []) + [-2.0, 41.0, 50.0, 50.0, 0.82]
            body += struct.pack('<' + 'f' * len(floats), *floats) + bytes([2, 1, 4, 1])
            wire = frame(b''.join(frame((k + '=' + v).encode()) for k, v in header.items())) + frame(body)
            class Stream:
                def __init__(self): self.data = io.BytesIO(wire); self.sent = b''
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def settimeout(self, seconds): pass
                def recv(self, count): return self.data.read(min(count, 7))
                def sendall(self, data): self.sent += data
            class Master:
                def getPublishedTopics(self, *args): return [1, '', [['/R_006/bms_node/battery_state', 'sensor_msgs/BatteryState']]]
                def getSystemState(self, *args): return [1, '', [[['/R_006/bms_node/battery_state', ['/bms']]], [], []]]
                def lookupNode(self, *args): return [1, '', 'http://127.0.0.1:1234']
                def requestTopic(self, *args): return [1, '', ['TCPROS', '127.0.0.1', 1235]]
            stream = Stream()
            with patch.object(battery.socket, 'setdefaulttimeout'), patch.object(battery.xmlrpc.client, 'ServerProxy', return_value=Master()), patch.object(battery.socket, 'create_connection', return_value=stream):
                result = battery.ros1_battery('R_006')
            self.assertEqual(result['status'], 'observed')
            self.assertAlmostEqual(result['percentage'], 0.82, places=5)
            self.assertAlmostEqual(result['voltage'], 51.2, places=4)
            self.assertEqual(result['power_supply_status'], 2)
            self.assertIn(b'md5sum=*', stream.sent)

    def test_ros2_subscribes_to_scoped_battery_with_sensor_qos(self):
        message = types.SimpleNamespace(percentage=0.75, voltage=50.1, current=1.2, present=True, power_supply_status=1,
                                        header=types.SimpleNamespace(stamp=types.SimpleNamespace(sec=int(time.time()), nanosec=0)))
        class Node:
            callback = None
            def get_topic_names_and_types(self): return [('/R_006/bms_node/battery_state', ['sensor_msgs/msg/BatteryState'])]
            def create_subscription(self, kind, topic, callback, qos): self.callback = callback; return object()
            def get_publishers_info_by_topic(self, topic): return [object()]
            def destroy_node(self): pass
        node = Node()
        def create_node(name, **options):
            self.assertFalse(options['enable_rosout'])
            self.assertFalse(options['start_parameter_services'])
            return node
        rclpy = types.ModuleType('rclpy')
        rclpy.init = lambda **kwargs: None
        rclpy.create_node = create_node
        rclpy.spin_once = lambda node, **kwargs: node.callback(message) if node.callback else None
        rclpy.shutdown = lambda: None
        qos = types.ModuleType('rclpy.qos'); qos.qos_profile_sensor_data = object()
        msg = types.ModuleType('sensor_msgs.msg'); msg.BatteryState = object()
        boolmsg = types.ModuleType('std_msgs.msg'); boolmsg.Bool = object()
        with patch.dict(sys.modules, {'rclpy': rclpy, 'rclpy.qos': qos, 'sensor_msgs': types.ModuleType('sensor_msgs'), 'sensor_msgs.msg': msg, 'std_msgs': types.ModuleType('std_msgs'), 'std_msgs.msg': boolmsg}):
            result = battery.ros2_battery('R_006')
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['percentage'], 0.75)

    def test_no_runtime_and_multiple_domains_do_not_launch_workers(self):
        with patch.object(battery.subprocess, 'Popen') as spawn:
            self.assertEqual(battery.collect_battery([], None, '')['status'], 'not_running')
            contexts = [{'generation': 'ros2', 'env': {'ROS_DOMAIN_ID': domain}} for domain in ('1', '2')]
            self.assertEqual(battery.collect_battery(contexts, None, '')['status'], 'ambiguous')
            spawn.assert_not_called()

    def test_ros2_reads_charging_signal_only_from_its_io_driver(self):
        for wrong_publisher in (False, True):
            bms = types.SimpleNamespace(percentage=0.4, voltage=53.8, current=7.93, present=True, power_supply_status=3,
                                        header=types.SimpleNamespace(stamp=types.SimpleNamespace(sec=int(time.time()), nanosec=0)))
            class Node:
                def __init__(self): self.callbacks = {}
                def get_topic_names_and_types(self):
                    return [('/R_006/battery_state', ['sensor_msgs/msg/BatteryState']),
                            ('/R_006/io/state_monitor/charging', ['std_msgs/msg/Bool']),
                            ('/R_007/io/state_monitor/charging', ['std_msgs/msg/Bool'])]
                def create_subscription(self, kind, topic, callback, qos): self.callbacks[topic] = callback; return object()
                def get_publishers_info_by_topic(self, topic):
                    name = 'bms_node' if topic.endswith('/battery_state') else 'other' if wrong_publisher else 'io_driver_node'
                    return [types.SimpleNamespace(node_name=name, node_namespace='/R_006')]
                def destroy_node(self): pass
            node = Node(); rclpy = types.ModuleType('rclpy'); rclpy.init = lambda **kwargs: None
            rclpy.create_node = lambda *args, **kwargs: node; rclpy.shutdown = lambda: None
            def spin(*args, **kwargs):
                for topic, callback in node.callbacks.items(): callback(bms if topic.endswith('/battery_state') else types.SimpleNamespace(data=True))
            rclpy.spin_once = spin
            qos = types.ModuleType('rclpy.qos'); qos.qos_profile_sensor_data = object()
            msg = types.ModuleType('sensor_msgs.msg'); msg.BatteryState = object()
            boolmsg = types.ModuleType('std_msgs.msg'); boolmsg.Bool = object()
            modules = {'rclpy': rclpy, 'rclpy.qos': qos, 'sensor_msgs': types.ModuleType('sensor_msgs'), 'sensor_msgs.msg': msg,
                       'std_msgs': types.ModuleType('std_msgs'), 'std_msgs.msg': boolmsg}
            with patch.dict(sys.modules, modules): result = battery.ros2_battery('R_006')
            self.assertEqual(result['publisher'], '/R_006/bms_node'); self.assertEqual(result['power_supply_status'], 3)
            self.assertEqual(result['io_charging']['status'], 'ambiguous' if wrong_publisher else 'observed')
            if not wrong_publisher: self.assertTrue(result['io_charging']['charging'])

    def test_worker_timeout_is_killed_and_reaped(self):
        with patch.object(battery.subprocess, 'Popen') as spawn:
            process = spawn.return_value
            process.communicate.side_effect = [battery.subprocess.TimeoutExpired('battery', 4.5), ('', None)]
            result = battery.collect_battery([{'generation': 'ros2', 'env': {}}], None, 'source')
            self.assertEqual(result['status'], 'timeout')
            process.kill.assert_called_once()
            self.assertEqual(process.communicate.call_count, 2)


if __name__ == '__main__':
    unittest.main()
