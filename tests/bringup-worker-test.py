import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bringup_worker', root / 'lib/bringup-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BringupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.source = self.home / '.bash_aliases'
        self.source.write_text('bringup() { :; }\n')
        self.source.chmod(0o644)
        self.profile = {'rid': 'R_006', 'domain': 6, 'files': [
            {'path': '.bash_aliases', 'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest()}]}
        self.cmd = {'requestId': 'a' * 32, 'expectedRevision': 'b' * 64}
        self.running = {'state': 'running', 'canStop': True, 'canStart': False,
                        'revision': 'b' * 64, 'reason': '', 'process': {'pid': 99999, 'start': '10'}}
        self.stopped = {'state': 'stopped', 'canStop': False, 'canStart': True,
                        'revision': 'b' * 64, 'reason': '', 'process': None}
        self.home_patch = patch.object(Path, 'home', return_value=self.home)
        self.home_patch.start()

    def tearDown(self):
        self.home_patch.stop()
        self.temporary.cleanup()

    def process(self, **change):
        result = {'pid': 99999, 'start': '10', 'launch': True, 'rid': 'R_006', 'domain': '6', 'native': True, 'managed': False}
        result.update(change)
        return result

    def inspect_with(self, processes, unit_state='not-found\n'):
        with patch.object(Path, 'glob', return_value=[Path('/proc/' + str(i)) for i in range(len(processes))]), \
             patch.object(worker, 'read_process', side_effect=processes), \
             patch.object(worker.subprocess, 'run', return_value=types.SimpleNamespace(stdout=unit_state)), \
             patch.object(worker.os, 'pidfd_open', create=True) as opener, \
             patch.object(worker.signal, 'pidfd_send_signal', create=True) as sender:
            value = worker.inspect(self.profile)
            opener.assert_not_called()
            sender.assert_not_called()
            return value

    def test_service_presence_or_unknown_service_status_blocks_control(self):
        for unit in ['loaded\n', '']:
            self.assertFalse(self.inspect_with([], unit)['canStart'])
            self.assertFalse(self.inspect_with([self.process()], unit)['canStop'])

    def test_status_only_reads_and_refuses_other_roots_and_leftovers(self):
        self.assertEqual(self.inspect_with([])['state'], 'stopped')
        self.assertEqual(self.inspect_with([self.process()])['state'], 'running')
        for data in [[self.process(rid='R_011')], [self.process(launch=False)], [self.process(), self.process(pid=222)]]:
            value = self.inspect_with(data)
            self.assertFalse(value['canStart'])
            self.assertFalse(value['canStop'])

    def test_process_identity_and_service_ownership_are_read_without_other_environment(self):
        folder = self.home / '123'; folder.mkdir()
        (folder / 'cmdline').write_bytes(b'python3\0/opt/ros/jazzy/bin/ros2\0launch\0spx_bringup\0bringup.launch.py\0ns:=R_006\0')
        fields = ['S'] + ['0'] * 18 + ['987654'] + ['0'] * 6
        (folder / 'stat').write_text('123 (python3) ' + ' '.join(fields))
        (folder / 'environ').write_bytes(b'ROS_HOSTNAME=R_006\0ROS_DOMAIN_ID=6\0SECRET=private-value\0')
        (folder / 'cgroup').write_text('0::/user.slice/user-1000.slice/session-1.scope\n')
        value = worker.read_process(folder)
        self.assertTrue(value['launch']); self.assertFalse(value['managed'])
        self.assertEqual(value['start'], '987654'); self.assertNotIn('private-value', json.dumps(value))
        (folder / 'cgroup').write_text('0::/user.slice/user-1000.slice/user@1000.service/app.slice/bringup.service\n')
        self.assertTrue(worker.read_process(folder)['managed'])

    def test_changed_source_disables_start(self):
        self.source.write_text('changed\n')
        value = self.inspect_with([])
        self.assertFalse(value['canStart'])
        self.assertIn('변경', value['reason'])

    def test_pending_wrapper_blocks_another_start(self):
        folder = self.home / '.local/state/amr-fleet-bringup'
        folder.mkdir(parents=True)
        (folder / 'last-request.json').write_text(json.dumps({'rid': 'R_006', 'wrapper': {'pid': 99999, 'start': '10'}}))
        value = self.inspect_with([self.process(launch=False, native=False)])
        self.assertEqual(value['state'], 'starting')
        self.assertFalse(value['canStart'])

    def test_revision_change_never_sends_signal(self):
        with patch.object(worker, 'inspect', return_value={**self.running, 'revision': 'c' * 64}), \
             patch.object(worker.signal, 'pidfd_send_signal', create=True) as sender:
            with self.assertRaises(worker.Refused):
                worker.perform(self.profile, 'stop', self.cmd)
            sender.assert_not_called()

    def test_stop_uses_one_pidfd_sigint_and_replays_receipt_without_signal(self):
        fd = os.open('/dev/null', os.O_RDONLY)
        with patch.object(worker, 'inspect', side_effect=[self.running, self.running, self.stopped, self.stopped]), \
             patch.object(worker.os, 'pidfd_open', create=True, return_value=fd) as opener, \
             patch.object(worker.signal, 'pidfd_send_signal', create=True) as sender, \
             patch.object(worker.time, 'sleep'):
            result = worker.perform(self.profile, 'stop', self.cmd)
            self.assertEqual(result['status'], 'confirmed')
            opener.assert_called_once_with(99999)
            sender.assert_called_once_with(fd, signal.SIGINT)
        # The latest marker can change; request receipts still prevent replay.
        (self.home / '.local/state/amr-fleet-bringup/last-request.json').write_text('{}')
        with patch.object(worker.signal, 'pidfd_send_signal', create=True) as sender, patch.object(worker, 'inspect') as inspect:
            self.assertEqual(worker.perform(self.profile, 'stop', self.cmd)['status'], 'confirmed')
            sender.assert_not_called()
            inspect.assert_not_called()

    def test_pid_identity_changes_after_pidfd_open_block_signal(self):
        fd = os.open('/dev/null', os.O_RDONLY)
        with patch.object(worker, 'inspect', side_effect=[self.running, {**self.running, 'revision': 'c' * 64}]), \
             patch.object(worker.os, 'pidfd_open', create=True, return_value=fd), \
             patch.object(worker.signal, 'pidfd_send_signal', create=True) as sender:
            with self.assertRaises(worker.Refused):
                worker.perform(self.profile, 'stop', self.cmd)
            sender.assert_not_called()

    def test_start_detaches_existing_function_and_uses_robot_identity(self):
        child = Mock(pid=99999)
        child.poll.return_value = None
        with patch.object(worker, 'inspect', side_effect=[self.stopped, self.running, self.running]), \
             patch.object(worker, 'read_process', return_value=self.process()), \
             patch.object(worker.subprocess, 'Popen', return_value=child) as launch, patch.object(worker.time, 'sleep'):
            result = worker.perform(self.profile, 'start', self.cmd)
            self.assertEqual(result['status'], 'confirmed')
            args, kwargs = launch.call_args
            self.assertIn('bringup', args[0][4])
            self.assertEqual(args[0][-1], str(self.source))
            self.assertTrue(kwargs['start_new_session'])
            self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
            self.assertEqual(kwargs['env']['ROS_HOSTNAME'], 'R_006')
            self.assertEqual(kwargs['env']['ROS_DOMAIN_ID'], '6')

    def test_pending_or_corrupt_receipt_cannot_dispatch_again(self):
        folder = self.home / '.local/state/amr-fleet-bringup/requests'
        folder.mkdir(parents=True)
        receipt = folder / (self.cmd['requestId'] + '.json')
        receipt.write_text(json.dumps({'requestId': self.cmd['requestId'], 'action': 'start', 'rid': 'R_006', 'revision': self.cmd['expectedRevision']}))
        with patch.object(worker.subprocess, 'Popen') as launch:
            self.assertEqual(worker.perform(self.profile, 'start', self.cmd)['status'], 'unconfirmed')
            launch.assert_not_called()
        receipt.write_text('{')
        with self.assertRaises(worker.Refused):
            worker.perform(self.profile, 'start', self.cmd)


if __name__ == '__main__':
    unittest.main()
