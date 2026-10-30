import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pwd
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

root = Path(__file__).resolve().parents[1]


def module(name, files):
    value = types.ModuleType(name)
    exec(compile('\n'.join((root / 'lib' / file).read_text() for file in files), name, 'exec'), value.__dict__)
    return value


io = module('ros1_io', ['ros1-runtime.py', 'io-probe.py', 'io-output.py'])
battery = module('ros1_battery', ['ros1-runtime.py', 'battery-probe.py', 'battery-stream.py'])
worker = module('bringup_worker', ['bringup-worker.py'])


class Ros1Tests(unittest.TestCase):
    def node(self):
        rospy = types.ModuleType('rospy')
        rospy.init_node = Mock(); rospy.get_name = lambda: '/fleet_test'
        rospy.signal_shutdown = Mock()
        rospy.Subscriber = Mock()
        with patch.dict(sys.modules, {'rospy': rospy}):
            node = io.Ros1Node('fleet_test')
        node.master = Mock()
        node.master.getSystemState.return_value = (1, '', [
            [('/R_001/io/status', ['/R_001/io_driver_node'])], [],
            [('/R_001/io/set_output', ['/R_001/io_driver_node']), ('/R_001/io/get_input', ['/R_001/io_driver_node'])]])
        node.master.getPublishedTopics.return_value = (1, '', [('/R_001/io/status', 'spx_msgs/IoStatus')])
        return node

    def test_ros1_graph_and_connection_metadata_verify_the_actual_publisher(self):
        node = self.node(); values = []
        self.assertIn(('io_driver_node', '/R_001'), node.get_node_names_and_namespaces())
        self.assertEqual(node.get_publisher_names_and_types_by_node('io_driver_node', '/R_001'),
                         [('/R_001/io/status', ['spx_io_msgs/msg/IoStatus'])])
        node.create_subscription(object, '/R_001/io/status', values.append, None)
        callback = node.rospy.Subscriber.call_args.args[2]
        callback(types.SimpleNamespace(_connection_header={'callerid': '/fake'}))
        self.assertEqual(values, [])
        sample = types.SimpleNamespace(_connection_header={'callerid': '/R_001/io_driver_node'})
        callback(sample); self.assertEqual(values, [sample])
        node.destroy_node(); node.rospy.signal_shutdown.assert_called_once()

    def test_ros1_service_ownership_and_type_must_both_match(self):
        node = self.node(); node.expected_driver = '/R_001/io_driver_node'
        with patch.object(node, 'service_headers', return_value={'callerid': node.expected_driver, 'type': 'spx_msgs/SetOutput'}) as headers_probe:
            self.assertTrue(node.service_verified('/R_001/io/set_output', 'spx_msgs/SetOutput'))
            for headers in [{'callerid': '/wrong', 'type': 'spx_msgs/SetOutput'},
                            {'callerid': node.expected_driver, 'type': 'std_srvs/Trigger'}]:
                headers_probe.return_value = headers
                self.assertFalse(node.service_verified('/R_001/io/set_output', 'spx_msgs/SetOutput'))
            self.assertFalse(node.service_verified('/R_002/io/set_output', 'spx_msgs/SetOutput'))

    def test_ros1_io_context_and_seconds_timestamp_are_supported_without_guessing_identity(self):
        context = {'generation': 'ros1', 'namespace': '/R_001', 'env': {}}
        self.assertEqual(io.io_context([context], 'R_001'), (context, None))
        self.assertEqual(io.io_context([context], 'R_002')[1]['status'], 'identity_unknown')
        sample = types.SimpleNamespace(header=types.SimpleNamespace(stamp=types.SimpleNamespace(secs=int(time.time()), nsecs=0)),
                                       di_channels=[], do_channels=[])
        self.assertEqual(io.io_snapshot(sample, '/R_001/io/status', '/R_001')['status'], 'empty')

    def test_ros1_output_uses_ros1_request_classes_and_one_write_then_logical_readback(self):
        ros2tests = root / 'tests/io-output-test.py'
        spec = importlib.util.spec_from_file_location('output_fixtures', ros2tests)
        fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
        sample, latest, command = fixtures.fixture()
        sample.header.stamp = types.SimpleNamespace(secs=int(time.time()), nsecs=0)
        class Service:
            _request_class = type('Request', (), {})
        srv = types.ModuleType('spx_msgs.srv'); srv.SetOutput = srv.GetInput = Service
        node, values = fixtures.Node(), []
        with patch.dict(sys.modules, {'spx_msgs': types.ModuleType('spx_msgs'), 'spx_msgs.srv': srv}):
            controller = io.IoOutputController(node, '/R_006', values.append, generation='ros1')
        controller.accept(command, latest, True)
        controller.tick(latest, True); controller.tick(latest, True)
        latest[0] = (sample, time.monotonic() + .001)
        controller.tick(latest, True); controller.tick(latest, True)
        self.assertEqual(values[-1]['status'], 'confirmed')
        controller.accept(command, latest, True)
        self.assertEqual(len(node.writer.calls), 1)

    def test_ros1_battery_live_delivers_bms_charging_discharging_and_idle(self):
        clock, outputs, callbacks, subscriptions = [100.], [], {}, []
        class Node:
            def get_topic_names_and_types(self): return [('/R_001/battery_state', ['sensor_msgs/msg/BatteryState'])]
            def get_publishers_info_by_topic(self, topic): return [types.SimpleNamespace(node_name='bms_node', node_namespace='/R_001')]
            def create_subscription(self, kind, topic, callback, qos):
                callbacks[topic] = callback; subscriptions.append(topic); return object()
            def destroy_node(self): pass
        sensor = types.ModuleType('sensor_msgs.msg'); sensor.BatteryState = object
        std = types.ModuleType('std_msgs.msg'); std.Bool = object
        modules = {'sensor_msgs': types.ModuleType('sensor_msgs'), 'sensor_msgs.msg': sensor,
                   'std_msgs': types.ModuleType('std_msgs'), 'std_msgs.msg': std}
        def spin(_):
            clock[0] += .1
            for callback in callbacks.values():
                state = [1, 2, 3][int((clock[0] - 100) * 2) % 3]
                callback(types.SimpleNamespace(percentage=.81, voltage=56., current=2., present=True, power_supply_status=state,
                         header=types.SimpleNamespace(stamp=types.SimpleNamespace(secs=int(time.time()), nsecs=0))))
        with patch.dict(sys.modules, modules), patch.object(battery, 'Ros1Node', return_value=Node()), \
             patch.object(battery.time, 'sleep', side_effect=spin), patch.object(battery.time, 'monotonic', side_effect=lambda: clock[0]):
            battery.ros2_battery_stream('R_001', [], outputs.append, lambda: clock[0] < 102.5, generation='ros1')
        observed = [r for r in outputs if r['status'] == 'observed']
        self.assertEqual({r['power_supply_status'] for r in observed}, {1, 2, 3})
        self.assertEqual({r['source'] for r in observed}, {'ros1'})
        self.assertEqual(len(subscriptions), 1)

    def test_systemd_status_checks_pinned_unit_environment_identity_and_existing_permissions(self):
        profile = {'rid': 'R_001', 'backend': 'ros1_systemd', 'unitSha256': hashlib.sha256(b'unit').hexdigest(),
                   'environmentSha256': hashlib.sha256(b'ROS_HOSTNAME=R_001\n').hexdigest()}
        fields = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'MainPID': '908',
                  'User': pwd.getpwuid(os.getuid()).pw_name, 'KillSignal': '2', 'Job': '',
                  'ExecStart': '{ path=/test/scorpion.sh ; argv[]=/test/scorpion.sh ; details }'}
        process = {'pid': 908, 'start': '123', 'ros1_launch': True, 'launch': False, 'native': False,
                   'rid': 'R_001', 'scorpion': True}
        def run(args, **kwargs):
            self.assertFalse(args[:3] == ['/usr/bin/sudo', '-n', '/usr/bin/systemctl'])
            if args[1] == 'cat': return types.SimpleNamespace(stdout=b'unit', returncode=0)
            if args[1] == 'show': return types.SimpleNamespace(stdout='\n'.join(k+'='+v for k,v in fields.items()), returncode=0)
            return types.SimpleNamespace(returncode=0)
        with patch.object(worker, 'valid_profile', return_value=Path('/test/scorpion.sh')), \
             patch.object(worker.subprocess, 'run', side_effect=run), \
             patch.object(Path, 'read_bytes', return_value=b'ROS_HOSTNAME=R_001\n'), \
             patch.object(Path, 'stat', return_value=types.SimpleNamespace(st_uid=0, st_mode=0o644)), \
             patch.object(Path, 'glob', return_value=[Path('/proc/908')]), patch.object(worker, 'read_process', return_value=process):
            self.assertTrue(worker.inspect(profile)['canStop'])
            process['rid'] = 'R_002'
            self.assertFalse(worker.inspect(profile)['canStop'])
            process['rid'] = 'R_001'; profile['unitSha256'] = '0' * 64
            self.assertFalse(worker.inspect(profile)['canStop'])

    def test_systemd_dispatch_is_one_fixed_command_and_revision_changes_block_it(self):
        current = {'revision': 'b' * 64}
        with patch.object(worker, 'inspect', side_effect=[current, {'state': 'stopped', 'reason': ''}]), \
             patch.object(worker.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run, \
             patch.object(worker.time, 'sleep'):
            result = worker.dispatch_systemd({}, 'stop', current)
            self.assertEqual(result['status'], 'confirmed')
            self.assertEqual(run.call_args.args[0], ['/usr/bin/sudo', '-n', '/usr/bin/systemctl', '--no-block', 'stop', 'scorpion.service'])
            self.assertEqual(run.call_count, 1)
        with patch.object(worker, 'inspect', return_value={'revision': 'c' * 64}), patch.object(worker.subprocess, 'run') as run:
            with self.assertRaises(worker.Refused): worker.dispatch_systemd({}, 'start', current)
            run.assert_not_called()

    def test_systemd_requests_replay_the_durable_receipt_without_another_service_command(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(Path, 'home', return_value=Path(folder)):
            profile = {'rid': 'R_001', 'backend': 'ros1_systemd'}
            current = {'revision': 'b' * 64, 'canStop': True, 'canStart': False}
            command = {'requestId': 'a' * 32, 'expectedRevision': 'b' * 64}
            with patch.object(worker, 'inspect', return_value=current), \
                 patch.object(worker, 'dispatch_systemd', return_value={'status': 'confirmed', 'mayHaveApplied': True}) as dispatch:
                self.assertEqual(worker.perform(profile, 'stop', command)['status'], 'confirmed')
                self.assertEqual(worker.perform(profile, 'stop', command)['status'], 'confirmed')
                self.assertEqual(dispatch.call_count, 1)


if __name__ == '__main__': unittest.main()
