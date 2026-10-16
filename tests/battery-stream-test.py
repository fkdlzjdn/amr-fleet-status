import json
import os
from pathlib import Path
import subprocess
import sys
import time
import types
import unittest
from unittest.mock import patch

root = Path(__file__).parents[1]
source = (root / 'lib/battery-probe.py').read_text() + '\n' + (root / 'lib/battery-stream.py').read_text()
module = types.ModuleType('battery_stream'); exec(compile(source, '<battery_stream_test>', 'exec'), module.__dict__)


class StreamTests(unittest.TestCase):
    def test_persistent_subscription_delivers_positive_negative_and_idle_current(self):
        clock, outputs = [100.0], []
        profile = {'plugin': 'spx_bms_slec_plugin', 'current_sign': 'positive_charging', 'publisher': '/R_006/bms_node', 'pid': 1}
        class Node:
            def __init__(self): self.callbacks = {}; self.created = 0; self.tick = 0
            def get_topic_names_and_types(self): return [('/R_006/battery_state', ['sensor_msgs/msg/BatteryState']), ('/R_006/io/state_monitor/charging', ['std_msgs/msg/Bool'])]
            def create_subscription(self, kind, topic, callback, qos): self.callbacks[topic] = callback; self.created += 1; return object()
            def get_publishers_info_by_topic(self, topic): return [types.SimpleNamespace(node_name='bms_node' if topic.endswith('battery_state') else 'io_driver_node', node_namespace='/R_006')]
            def destroy_node(self): self.destroyed = True
        node = Node(); rclpy = types.ModuleType('rclpy'); rclpy.init = lambda **kwargs: None
        rclpy.create_node = lambda *args, **kwargs: node; rclpy.shutdown = lambda: None
        def spin(*args, **kwargs):
            clock[0] += .06; node.tick += 1
            current = 7.4 if node.tick < 9 else -3.0 if node.tick < 18 else .05
            message = types.SimpleNamespace(percentage=.4, voltage=53.7, current=current, present=True, power_supply_status=3,
                                           header=types.SimpleNamespace(stamp=types.SimpleNamespace(sec=int(time.time()), nanosec=0)))
            for topic, callback in node.callbacks.items(): callback(message if topic.endswith('battery_state') else types.SimpleNamespace(data=True))
        rclpy.spin_once = spin
        qos = types.ModuleType('rclpy.qos'); qos.qos_profile_sensor_data = object()
        sensor = types.ModuleType('sensor_msgs.msg'); sensor.BatteryState = object()
        boolean = types.ModuleType('std_msgs.msg'); boolean.Bool = object()
        modules = {'rclpy': rclpy, 'rclpy.qos': qos, 'sensor_msgs': types.ModuleType('sensor_msgs'), 'sensor_msgs.msg': sensor,
                   'std_msgs': types.ModuleType('std_msgs'), 'std_msgs.msg': boolean}
        with patch.dict(sys.modules, modules), patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(module, 'live_current_profile', return_value=profile):
            module.ros2_battery_stream('R_006', [profile], outputs.append, lambda: clock[0] < 102.2)
        observed = [value for value in outputs if value['status'] == 'observed']
        self.assertEqual({value['current'] for value in observed}, {7.4, -3.0, .05})
        self.assertEqual(node.created, 2); self.assertTrue(node.destroyed)
        self.assertTrue(all(value['current_profile']['plugin'] == 'spx_bms_slec_plugin' for value in observed))

    def test_unknown_or_restarted_bms_does_not_inherit_an_old_current_sign(self):
        self.assertIsNone(module.live_current_profile([], '/R_006/bms_node'))
        self.assertIsNone(module.live_current_profile([{'publisher': '/R_006/bms_node', 'pid': 99999999}], '/R_006/bms_node'))

    def test_remote_subscriber_exits_on_ssh_stdin_eof(self):
        script = source + '''
def ros2_battery_stream(rid, profiles, emit, alive):
    while alive(): time.sleep(.01)
    print('stopped', flush=True)
battery_stream_worker('R_006', [])
'''
        process = subprocess.Popen([sys.executable, '-u', '-B', '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process.stdin.write(b'\n'); process.stdin.close(); process.stdin = None
        stdout, stderr = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 0, stderr.decode()); self.assertIn(b'stopped', stdout)


if __name__ == '__main__': unittest.main()
