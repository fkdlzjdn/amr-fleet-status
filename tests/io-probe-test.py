import importlib.util
import json
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import patch

root = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('io_probe', root / 'lib/io-probe.py')
io = importlib.util.module_from_spec(spec)
spec.loader.exec_module(io)


def message():
    raw = json.loads((root / 'tests/fixtures/r56-io-status.json').read_text())
    raw['header']['stamp'] = {'sec': int(time.time()), 'nanosec': 0}
    def convert(value):
        if isinstance(value, dict): return types.SimpleNamespace(**{key: convert(item) for key, item in value.items()})
        if isinstance(value, list): return [convert(item) for item in value]
        return value
    return convert(raw)


class IoProbeTests(unittest.TestCase):
    def test_reference_schema_and_stale_timestamp(self):
        sample = message()
        result = io.io_snapshot(sample, '/R_006/io/status', '/R_006')
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(len(result['di_channels']), 8)
        self.assertEqual(len(result['do_channels']), 8)
        self.assertEqual(result['di_channels'][0]['logical_name'], 'lift_up')
        sample.header.stamp.sec -= 30
        stale = io.io_snapshot(sample, '/R_006/io/status', '/R_006')
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual(stale['di_channels'], [])
        sample.header.stamp.sec = 0
        self.assertEqual(io.io_snapshot(sample, '/R_006/io/status', '/R_006')['status'], 'stale')

    def test_exact_node_publisher_and_namespace_are_required(self):
        for wrong in (None, 'publisher', 'namespace', 'duplicate_node'):
            sample = message()
            class Node:
                callback = None
                def get_node_names_and_namespaces(self): return [('io_driver_node', '/R_006')] * (2 if wrong == 'duplicate_node' else 1)
                def get_publisher_names_and_types_by_node(self, name, namespace):
                    return [('/R_007/io/status' if wrong == 'namespace' else '/R_006/io/status', ['spx_io_msgs/msg/IoStatus'])]
                def get_publishers_info_by_topic(self, topic):
                    return [types.SimpleNamespace(node_name='other' if wrong == 'publisher' else 'io_driver_node', node_namespace='/R_006')]
                def create_subscription(self, kind, topic, callback, qos): self.callback = callback; return object()
                def destroy_node(self): pass
            node = Node()
            rclpy = types.ModuleType('rclpy')
            rclpy.init = lambda **kwargs: None
            def create_node(name, **options):
                self.assertFalse(options['enable_rosout']); self.assertFalse(options['start_parameter_services'])
                return node
            rclpy.create_node = create_node
            rclpy.spin_once = lambda node, **kwargs: node.callback(sample) if node.callback else None
            rclpy.shutdown = lambda: None
            qos = types.ModuleType('rclpy.qos'); qos.qos_profile_sensor_data = object()
            msg = types.ModuleType('spx_io_msgs.msg'); msg.IoStatus = object()
            modules = {'rclpy': rclpy, 'rclpy.qos': qos, 'spx_io_msgs': types.ModuleType('spx_io_msgs'), 'spx_io_msgs.msg': msg}
            with patch.dict(sys.modules, modules):
                result = io.ros2_io('/R_006')
            self.assertEqual(result['status'], {None: 'observed', 'publisher': 'ambiguous', 'namespace': 'identity_unknown', 'duplicate_node': 'ambiguous'}[wrong])

    def test_no_runtime_wrong_identity_and_unsupported_ros_never_launch(self):
        with patch.object(io.subprocess, 'Popen') as spawn:
            self.assertEqual(io.collect_io([], 'R_006', '')['status'], 'node_not_found')
            self.assertEqual(io.collect_io([{'generation': 'other'}], 'R_006', '')['status'], 'unsupported')
            self.assertEqual(io.collect_io([{'generation': 'ros2', 'namespace': '/R_007'}], 'R_006', '')['status'], 'identity_unknown')
            self.assertEqual(io.collect_io([{}, {}], 'R_006', '')['status'], 'ambiguous')
            spawn.assert_not_called()

    def test_io_worker_timeout_kills_and_reaps(self):
        with patch.object(io.subprocess, 'Popen') as spawn:
            process = spawn.return_value
            process.communicate.side_effect = [io.subprocess.TimeoutExpired('io', 4.5), ('', None)]
            result = io.collect_io([{'generation': 'ros2', 'namespace': '/R_006', 'env': {}}], 'R_006', '')
            self.assertEqual(result['status'], 'timeout')
            process.kill.assert_called_once()
            self.assertEqual(process.communicate.call_count, 2)

    def test_stream_keeps_one_subscription_and_delivers_successive_samples(self):
        sample, clock, outputs = message(), [100.0], []
        class Node:
            callback = None
            subscriptions = 0
            def get_node_names_and_namespaces(self): return [('io_driver_node', '/R_006')]
            def get_publisher_names_and_types_by_node(self, *args): return [('/R_006/io/status', ['spx_io_msgs/msg/IoStatus'])]
            def get_publishers_info_by_topic(self, topic): return [types.SimpleNamespace(node_name='io_driver_node', node_namespace='/R_006')]
            def create_subscription(self, kind, topic, callback, qos): self.callback = callback; self.subscriptions += 1; return object()
            def destroy_node(self): self.destroyed = True
        node = Node()
        rclpy = types.ModuleType('rclpy'); rclpy.init = lambda **kwargs: None
        rclpy.create_node = lambda *args, **kwargs: node; rclpy.shutdown = lambda: None
        def spin(*args, **kwargs):
            clock[0] += 0.06
            if node.callback:
                sample.di_channels[0].value = 1 - sample.di_channels[0].value
                node.callback(sample)
        rclpy.spin_once = spin
        qos = types.ModuleType('rclpy.qos'); qos.qos_profile_sensor_data = object()
        msg = types.ModuleType('spx_io_msgs.msg'); msg.IoStatus = object()
        modules = {'rclpy': rclpy, 'rclpy.qos': qos, 'spx_io_msgs': types.ModuleType('spx_io_msgs'), 'spx_io_msgs.msg': msg}
        with patch.dict(sys.modules, modules), patch.object(io.time, 'monotonic', side_effect=lambda: clock[0]):
            io.ros2_io_stream('/R_006', outputs.append, lambda: clock[0] < 101.5)
        observed = [value for value in outputs if value['status'] == 'observed']
        self.assertGreater(len(observed), 5); self.assertEqual(node.subscriptions, 1); self.assertTrue(node.destroyed)
        self.assertEqual({value['di_channels'][0]['value'] for value in observed}, {0, 1})

    def test_remote_stream_exits_when_ssh_stdin_closes(self):
        source = (root / 'lib/io-probe.py').read_text() + '''
def ros2_io_stream(namespace, emit, alive, commands=None):
    while alive(): time.sleep(0.01)
    print('stopped', flush=True)
io_stream_worker('/R_006')
'''
        process = io.subprocess.Popen([sys.executable, '-u', '-B', '-c', source], stdin=io.subprocess.PIPE,
                                      stdout=io.subprocess.PIPE, stderr=io.subprocess.PIPE)
        process.stdin.write(b'\n'); process.stdin.close(); process.stdin = None
        stdout, stderr = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 0, stderr.decode()); self.assertIn(b'stopped', stdout)


if __name__ == '__main__': unittest.main()
