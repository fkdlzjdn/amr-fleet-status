import importlib.util
import json
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import patch

root = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('io_output', root / 'lib/io-output.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class Service:
    class Request: pass


class Client:
    def __init__(self, response): self.calls = []; self.response = response; self.complete = True
    def service_is_ready(self): return True
    def call_async(self, request):
        self.calls.append(request)
        return types.SimpleNamespace(done=lambda: self.complete, result=lambda: self.response)


class Node:
    def __init__(self, accepted=True, read_value=1.0):
        self.writer = Client(types.SimpleNamespace(success=accepted, message='Driver protection denied' if not accepted else 'OK'))
        self.reader = Client(types.SimpleNamespace(success=True, value=read_value, message='OK'))
    def create_client(self, kind, name): return self.writer if name.endswith('set_output') else self.reader
    def get_service_names_and_types_by_node(self, *args):
        return [('/R_006/io/set_output', ['spx_io_msgs/srv/SetOutput']), ('/R_006/io/get_input', ['spx_io_msgs/srv/GetInput'])]


def fixture():
    raw = json.loads((root / 'tests/fixtures/r56-io-status.json').read_text())
    def convert(value):
        if isinstance(value, dict): return types.SimpleNamespace(**{k: convert(v) for k, v in value.items()})
        if isinstance(value, list): return [convert(v) for v in value]
        return value
    sample = convert(raw); sample.header.stamp.sec = int(time.time()); sample.header.stamp.nanosec = 0
    command = {'type': 'set_output', 'requestId': 'a' * 32, 'deviceName': 'ezi_io_main', 'channel': 0,
               'logicalName': 'front_reset', 'value': 1, 'expectedValue': 0}
    return sample, [(sample, time.monotonic())], command


class OutputTests(unittest.TestCase):
    def controller(self, node, results):
        srv = types.ModuleType('spx_io_msgs.srv'); srv.SetOutput = Service; srv.GetInput = Service
        with patch.dict(sys.modules, {'spx_io_msgs': types.ModuleType('spx_io_msgs'), 'spx_io_msgs.srv': srv}):
            return module.IoOutputController(node, '/R_006', results.append)

    def test_logical_on_confirmed_separately_from_raw_value_without_repeating_write(self):
        node, results = Node(read_value=1.0), []
        controller = self.controller(node, results); sample, latest, command = fixture()
        controller.accept(command, latest, True)
        controller.tick(latest, True); controller.tick(latest, True)
        self.assertEqual(node.writer.calls[0].logical_name, 'front_reset')
        self.assertEqual(node.writer.calls[0].value, 1.0)
        latest[0] = (sample, time.monotonic() + 0.001)
        controller.tick(latest, True); controller.tick(latest, True)
        self.assertEqual(results[-1]['status'], 'confirmed'); self.assertEqual(results[-1]['logical_value'], 1)
        self.assertEqual(sample.do_channels[0].value, 0.0)
        controller.accept(command, latest, True)
        self.assertEqual(len(node.writer.calls), 1); self.assertEqual(len(results), 2)

    def test_driver_protection_rejection_is_final_and_has_no_bypass(self):
        node, results = Node(accepted=False), []
        controller = self.controller(node, results); _, latest, command = fixture()
        controller.accept(command, latest, True); controller.tick(latest, True); controller.tick(latest, True)
        self.assertEqual(results[-1]['status'], 'rejected'); self.assertIn('protection', results[-1]['message'])
        self.assertEqual(len(node.writer.calls), 1); self.assertEqual(len(node.reader.calls), 0)
        controller.accept(command, latest, True); self.assertEqual(len(node.writer.calls), 1)

    def test_invalid_di_stale_and_changed_targets_never_call_write(self):
        for change in ('invalid', 'di', 'old', 'changed', 'namespace'):
            node, results = Node(), []; controller = self.controller(node, results)
            sample, latest, command = fixture()
            if change == 'invalid': sample.do_channels[0].is_valid = False
            if change == 'di': command.update(logicalName='lift_up', expectedValue=1)
            if change == 'old': sample.header.stamp.sec -= 30
            if change == 'changed': command['expectedValue'] = 1
            controller.accept(command, latest, change != 'namespace'); controller.tick(latest, True)
            self.assertEqual(results[-1]['status'], 'rejected'); self.assertEqual(len(node.writer.calls), 0)

    def test_readback_mismatch_and_service_timeout_are_unconfirmed_without_retry(self):
        node, results = Node(read_value=0.0), []; controller = self.controller(node, results)
        sample, latest, command = fixture(); controller.accept(command, latest, True)
        controller.tick(latest, True); controller.tick(latest, True)
        latest[0] = (sample, time.monotonic() + 0.001)
        controller.tick(latest, True); controller.tick(latest, True)
        self.assertEqual(results[-1]['status'], 'unconfirmed'); self.assertEqual(len(node.writer.calls), 1)
        node, results = Node(), []; node.writer.complete = False; controller = self.controller(node, results)
        _, latest, command = fixture(); controller.accept(command, latest, True); controller.tick(latest, True)
        controller.pending['started'] -= 5
        controller.tick(latest, True)
        self.assertEqual(results[-1]['status'], 'unconfirmed'); self.assertTrue(results[-1]['may_have_applied'])
        controller.tick(latest, True); self.assertEqual(len(node.writer.calls), 1)

    def test_stream_command_queue_reaches_guarded_service_and_returns_logical_confirmation(self):
        io_spec = importlib.util.spec_from_file_location('io_probe_output_test', root / 'lib/io-probe.py')
        io = importlib.util.module_from_spec(io_spec); io_spec.loader.exec_module(io)
        sample, _, command = fixture(); commands, results, clock = [], [], [100.0]
        class StreamNode(Node):
            callback = None
            queued = False
            def get_node_names_and_namespaces(self): return [('io_driver_node', '/R_006')]
            def get_publisher_names_and_types_by_node(self, *args): return [('/R_006/io/status', ['spx_io_msgs/msg/IoStatus'])]
            def get_publishers_info_by_topic(self, *args): return [types.SimpleNamespace(node_name='io_driver_node', node_namespace='/R_006')]
            def create_subscription(self, kind, topic, callback, qos): self.callback = callback; return object()
            def destroy_node(self): pass
        node = StreamNode()
        rclpy = types.ModuleType('rclpy'); rclpy.init = lambda **kwargs: None
        rclpy.create_node = lambda *args, **kwargs: node; rclpy.shutdown = lambda: None
        def spin(*args, **kwargs):
            clock[0] += 0.06
            if node.callback:
                node.callback(sample)
                if clock[0] > 100.6 and not node.queued:
                    commands.append(command); node.queued = True
        rclpy.spin_once = spin
        qos = types.ModuleType('rclpy.qos'); qos.qos_profile_sensor_data = object()
        msg = types.ModuleType('spx_io_msgs.msg'); msg.IoStatus = object()
        srv = types.ModuleType('spx_io_msgs.srv'); srv.SetOutput = Service; srv.GetInput = Service
        modules = {'rclpy': rclpy, 'rclpy.qos': qos, 'spx_io_msgs': types.ModuleType('spx_io_msgs'), 'spx_io_msgs.msg': msg, 'spx_io_msgs.srv': srv}
        with patch.dict(sys.modules, modules), patch.object(io, 'IoOutputController', module.IoOutputController, create=True), patch.object(io, 'io_control_emit', results.append), patch.object(io.time, 'monotonic', side_effect=lambda: clock[0]):
            io.ros2_io_stream('/R_006', lambda value: None, lambda: clock[0] < 102, commands)
        self.assertEqual(len(node.writer.calls), 1)
        self.assertEqual(results[-1]['status'], 'confirmed')


if __name__ == '__main__': unittest.main()
