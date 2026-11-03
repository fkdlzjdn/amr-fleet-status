import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('jog_worker', Path(__file__).resolve().parents[1] / 'lib/jog-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.lease = worker.JogLease(now=lambda: self.now)

    def command(self, direction, sequence=1, challenge=None):
        return {'direction': direction, 'sequence': sequence,
                'challenge': challenge or self.lease.challenge()}

    def test_default_speed_for_all_four_directions(self):
        for sequence, (direction, velocity) in enumerate([
                ('forward', (0.25, 0)), ('backward', (-0.25, 0)),
                ('left', (0, 0.25)), ('right', (0, -0.25))]):
            command = self.command(direction, sequence)
            self.assertTrue(self.lease.accept(command, True))
            self.assertEqual(self.lease.velocity(True), velocity)

    def test_independent_speed_limits_and_zero(self):
        for sequence, (direction, linear, angular, expected) in enumerate([
                ('forward', 1.0, 0.3, (1.0, 0)), ('backward', 0.4, 0.8, (-0.4, 0)),
                ('left', 0.9, 1.0, (0, 1.0)), ('right', 0.6, 0.2, (0, -0.2)),
                ('forward', 0, 1, (0, 0)), ('left', 1, 0, (0, 0))]):
            command = dict(self.command(direction, sequence), linearSpeed=linear, angularSpeed=angular)
            self.assertTrue(self.lease.accept(command, True))
            self.assertEqual(self.lease.velocity(True), expected)
        for value in [-0.01, 1.01, float('nan'), float('inf'), True, None, '0.5']:
            self.assertFalse(self.lease.accept(dict(self.command('forward', 100), linearSpeed=value), True))
        self.assertFalse(self.lease.accept(dict(self.command('forward', 100), immediate=True), True))

    def test_no_motion_until_explicit_input_and_stop_on_expired_input(self):
        self.assertEqual(self.lease.velocity(True), (0, 0))
        self.lease.accept(self.command('forward'), True)
        self.now += 0.351
        self.assertEqual(self.lease.velocity(True), (0, 0))
        self.assertEqual(self.lease.velocity(True), (0, 0))

    def test_late_ssh_messages_cannot_renew_an_expired_challenge(self):
        command = self.command('forward')
        self.now += 0.351
        self.assertFalse(self.lease.accept(command, True))
        self.assertEqual(self.lease.velocity(True), (0, 0))

    def test_release_overtaking_an_older_movement_cannot_restart(self):
        motion = self.command('forward', 1)
        self.assertTrue(self.lease.accept(self.command('stop', 2), False))
        self.assertFalse(self.lease.accept(motion, True))
        self.assertEqual(self.lease.velocity(True), (0, 0))

    def test_graph_loss_clears_motion_without_automatic_resume(self):
        self.lease.accept(self.command('left'), True)
        self.assertEqual(self.lease.velocity(False), (0, 0))
        self.assertEqual(self.lease.velocity(True), (0, 0))
        self.assertFalse(self.lease.accept(self.command('forward', 2), False))
        self.assertEqual(self.lease.velocity(True), (0, 0))


class RampTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.ramp = worker.VelocityRamp(now=lambda: self.now)

    def step(self, target, dt=0.05, immediate=False):
        self.now += dt
        return self.ramp.step(target, immediate=immediate)

    def test_acceleration_and_release_deceleration_for_both_signed_axes(self):
        for target, index, acceleration, deceleration in [
                ((1, 0), 0, 0.3, 0.6), ((-1, 0), 0, 0.3, 0.6),
                ((0, 1), 1, 0.6, 1.2), ((0, -1), 1, 0.6, 1.2)]:
            self.setUp()
            previous = 0
            for _ in range(100):
                value = self.step(target)[index]
                self.assertLessEqual(abs(value - previous), acceleration * 0.05 + 1e-9)
                self.assertLessEqual(abs(value), 1)
                previous = value
            self.assertEqual(abs(previous), 1)
            for _ in range(50):
                value = self.step((0, 0))[index]
                self.assertLessEqual(abs(value - previous), deceleration * 0.05 + 1e-9)
                self.assertLessEqual(abs(value), abs(previous))
                previous = value
            self.assertEqual(value, 0)

    def test_speed_reduction_uses_deceleration_without_overshoot(self):
        for _ in range(80):
            self.step((1, 0))
        previous = self.ramp.linear
        for _ in range(40):
            value, _ = self.step((0.2, 0))
            self.assertGreaterEqual(value, 0.2)
            self.assertLessEqual(previous - value, 0.6 * 0.05 + 1e-9)
            previous = value
        self.assertEqual(value, 0.2)

    def test_reversal_crosses_zero_before_accelerating_backwards(self):
        for _ in range(20):
            self.step((0.25, 0))
        values = [self.step((-0.25, 0))[0] for _ in range(40)]
        first_negative = next(i for i, value in enumerate(values) if value < 0)
        self.assertGreater(first_negative, 0)
        self.assertEqual(values[first_negative - 1], 0)
        self.assertEqual(values[-1], -0.25)

    def test_axis_transition_decelerates_before_rotation(self):
        for _ in range(20):
            self.step((0.25, 0))
        values = [self.step((0, 0.5)) for _ in range(40)]
        self.assertTrue(all(x == 0 or z == 0 for x, z in values))
        self.assertEqual(values[-1], (0, 0.5))

    def test_clock_stall_does_not_jump_and_immediate_stop_bypasses_ramp(self):
        self.assertLessEqual(self.step((1, 0), dt=5)[0], 0.3 * 0.1)
        for _ in range(50):
            self.step((1, 0))
        self.assertGreater(self.ramp.linear, 0)
        self.assertEqual(self.step((0, 0), immediate=True), (0, 0))


class WorkerTests(unittest.TestCase):
    def simulate(self, mode=True, release=True, command=True, graph=True, first_direction='forward'):
        clock, packets, published = [10.0], [], []
        class Twist:
            def __init__(self):
                self.linear = types.SimpleNamespace(x=0.0)
                self.angular = types.SimpleNamespace(z=0.0)

        class Node:
            frame = 0
            callback = None

            def create_publisher(self, *args):
                return types.SimpleNamespace(publish=lambda msg: published.append((clock[0], msg.linear.x, msg.angular.z)))

            def create_subscription(self, kind, topic, callback, qos):
                self.callback = callback

            def get_subscriptions_info_by_topic(self, topic):
                return [types.SimpleNamespace(node_name='cmd_vel_mux', node_namespace='/R_006', topic_type='geometry_msgs/msg/Twist')] if graph else []

            def get_publishers_info_by_topic(self, topic):
                if topic.endswith('/mode'):
                    return [types.SimpleNamespace(node_name='io_driver_node', node_namespace='/R_006', topic_type='std_msgs/msg/Bool')] if mode is not None else []
                return []

            def destroy_node(self):
                pass

        node = Node()

        def spin(*args, **kwargs):
            node.frame += 1
            clock[0] += 0.06
            if mode is not None:
                node.callback(types.SimpleNamespace(data=mode))

        def readable(*args):
            active = node.frame == 14 or (command and node.frame == 2) or (command and release and node.frame == 4)
            return ([1], [], []) if active else ([], [], [])

        def read(*args):
            if node.frame == 14:
                return b''
            value = {'direction': first_direction if node.frame == 2 else 'stop',
                     'sequence': node.frame, 'challenge': packets[-1]['challenge']}
            return (worker.json.dumps(value) + '\n').encode()

        modules = {'rclpy': types.SimpleNamespace(init=lambda **k: None, create_node=lambda *a, **k: node,
                                                spin_once=spin, shutdown=lambda: None),
                   'geometry_msgs': types.ModuleType('geometry_msgs'),
                   'geometry_msgs.msg': types.SimpleNamespace(Twist=Twist),
                   'std_msgs': types.ModuleType('std_msgs'), 'std_msgs.msg': types.SimpleNamespace(Bool=object)}
        with patch.dict(sys.modules, modules), patch.object(worker.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(worker.select, 'select', side_effect=readable), patch.object(worker.os, 'read', side_effect=read), \
             patch.object(worker.sys, 'stdin', types.SimpleNamespace(fileno=lambda: 3)), \
             patch.object(worker, 'emit', side_effect=lambda value: packets.append(value)):
            worker.run({'rid': 'R_006', 'domain': 6})
        return packets, published

    def test_auto_manual_and_missing_mode_signal_allow_jog_without_switching_robot_mode(self):
        for mode, label in [(True, 'auto'), (False, 'manual'), (None, 'unknown')]:
            with self.subTest(mode=mode):
                packets, published = self.simulate(mode=mode)
                self.assertTrue(any(0 < x <= 0.25 for _, x, _ in published))
                self.assertTrue(all(p['status'] == 'ready' for p in packets))
                self.assertEqual(packets[-1]['operatingMode'], label)

    def test_released_jog_retains_zero_priority_until_panel_closes(self):
        _, published = self.simulate()
        before = max(x for at, x, _ in published if at < 10.23)
        first_release = next(x for at, x, _ in published if at >= 10.23)
        self.assertGreater(first_release, 0)
        self.assertLess(first_release, before)
        after_release = [(at, x, z) for at, x, z in published if at >= 10.25]
        self.assertGreater(len(after_release), 5)
        self.assertGreater(after_release[-1][0], 10.7)
        self.assertTrue(all(x == z == 0 for _, x, z in after_release))

    def test_missing_input_stops_and_keeps_zero_in_auto(self):
        _, published = self.simulate(release=False)
        self.assertTrue(any(x > 0 for _, x, _ in published))
        self.assertTrue(all(x == z == 0 for at, x, z in published if at >= 10.5))

    def test_opening_panel_and_missing_mux_never_publish_motion(self):
        self.assertEqual(self.simulate(command=False)[1], [])
        packets, published = self.simulate(graph=False, release=False)
        self.assertEqual(published, [])
        self.assertTrue(all(p['status'] == 'blocked' for p in packets))

    def test_explicit_stop_works_before_the_first_movement_in_auto(self):
        _, published = self.simulate(first_direction='stop')
        self.assertGreater(len(published), 5)
        self.assertTrue(all(x == z == 0 for _, x, z in published))


if __name__ == '__main__':
    unittest.main()
