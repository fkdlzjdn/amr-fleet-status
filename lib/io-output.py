"""Explicit DO requests through the driver's guarded SetOutput service only."""
import math
import re
import time


class IoOutputController:
    def __init__(self, node, namespace, emit, generation='ros2'):
        if generation == 'ros1':
            from spx_msgs.srv import SetOutput, GetInput
        else:
            from spx_io_msgs.srv import SetOutput, GetInput
        self.node, self.namespace, self.emit = node, namespace, emit
        self.SetOutput, self.GetInput = SetOutput, GetInput
        self.write_name = namespace.rstrip('/') + '/io/set_output'
        self.read_name = namespace.rstrip('/') + '/io/get_input'
        self.writer = node.create_client(SetOutput, self.write_name)
        self.reader = node.create_client(GetInput, self.read_name)
        self.pending, self.results = None, {}

    def finish(self, status, message, logical_value=None):
        pending = self.pending
        if not pending:
            return
        result = {'request_id': pending['command']['requestId'], 'status': status, 'message': str(message)[:240],
                  'may_have_applied': pending.get('sent', False), 'logical_value': logical_value}
        self.results[result['request_id']] = result
        if len(self.results) > 256:
            del self.results[next(iter(self.results))]
        self.pending = None
        self.emit(result)

    def valid_target(self, command, latest):
        if not latest or time.monotonic() - latest[0][1] > 1.0:
            return False
        sample = latest[0][0]
        stamp = sample.header.stamp
        stamp = stamp.secs + stamp.nsecs / 1e9 if hasattr(stamp, 'secs') else stamp.sec + stamp.nanosec / 1e9
        age = time.time() - stamp
        if stamp <= 0 or age > 2 or age < -5:
            return False
        matching = [ch for ch in list(sample.di_channels) + list(sample.do_channels)
                    if ch.logical_name == command.get('logicalName')]
        if len(matching) != 1:
            return False
        channel = matching[0]
        return (channel.io_type == 1 and channel.is_valid is True and channel.value in (0.0, 1.0)
                and channel.device_name == command.get('deviceName') and channel.channel_id == command.get('channel')
                and channel.value == command.get('expectedValue'))

    def accept(self, command, latest, source_ready):
        request_id = command.get('requestId')
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32}', request_id):
            return
        if request_id in self.results:
            self.emit(self.results[request_id]); return
        if self.pending:
            if self.pending['command']['requestId'] != request_id:
                self.emit({'request_id': request_id, 'status': 'rejected', 'message': 'Another DO request is pending', 'may_have_applied': False})
            return
        self.pending = {'command': command, 'phase': 'ready', 'started': time.monotonic(), 'sent': False}
        if (command.get('type') != 'set_output' or type(command.get('value')) is not int or command['value'] not in (0, 1)
                or not source_ready or not self.valid_target(command, latest)):
            self.finish('rejected', 'DO channel or current state could not be verified'); return
        services = dict(self.node.get_service_names_and_types_by_node('io_driver_node', self.namespace))
        if ('spx_io_msgs/srv/SetOutput' not in services.get(self.write_name, [])
                or 'spx_io_msgs/srv/GetInput' not in services.get(self.read_name, [])):
            self.finish('rejected', 'Guarded DO services are unavailable')

    def tick(self, latest, source_ready):
        pending = self.pending
        if not pending:
            return
        command, now = pending['command'], time.monotonic()
        try:
            if now - pending['started'] > 4:
                self.finish('unconfirmed' if pending['sent'] else 'rejected', 'DO result timeout; request was not retried'); return
            if pending['phase'] == 'ready':
                if not source_ready or not self.valid_target(command, latest):
                    self.finish('rejected', 'DO state changed before dispatch'); return
                if self.writer.service_is_ready() and self.reader.service_is_ready():
                    request = (getattr(self.SetOutput, 'Request', None) or self.SetOutput._request_class)()
                    request.logical_name = command['logicalName']; request.value = float(command['value'])
                    pending['sent'] = True
                    pending['future'] = self.writer.call_async(request)
                    pending['phase'] = 'write'
                elif now - pending['started'] > 1:
                    self.finish('rejected', 'Guarded DO service discovery timed out')
            elif pending['phase'] == 'write' and pending['future'].done():
                result = pending['future'].result()
                if result is None:
                    self.finish('unconfirmed', 'Driver response unavailable; request was not retried')
                elif not result.success:
                    self.finish('rejected', result.message)
                else:
                    pending['phase'] = 'read_wait'; pending['acknowledged'] = now
            elif pending['phase'] == 'read_wait':
                if not source_ready:
                    self.finish('unconfirmed', 'Driver accepted request; current IO source is unavailable'); return
                if latest and latest[0][1] > pending['acknowledged'] and self.reader.service_is_ready():
                    request = (getattr(self.GetInput, 'Request', None) or self.GetInput._request_class)()
                    request.logical_name = command['logicalName']
                    pending['future'] = self.reader.call_async(request); pending['phase'] = 'read'
            elif pending['phase'] == 'read' and pending['future'].done():
                result = pending['future'].result()
                valid = result is not None and result.success and isinstance(result.value, (float, int)) and math.isfinite(result.value)
                if valid and result.value == command['value']:
                    self.finish('confirmed', 'Driver logical value confirmed', int(result.value))
                else:
                    self.finish('unconfirmed', 'Driver accepted request; requested logical value was not confirmed')
        except Exception:
            self.finish('unconfirmed' if pending['sent'] else 'rejected', 'DO service error; request was not retried')
