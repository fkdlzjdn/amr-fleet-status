"""Ephemeral ROS2 teleop publisher. No files, services or robot settings are changed."""
import json
import math
import os
import re
import secrets
import select
import sys
import time
from pathlib import Path

DEFAULT_SPEED = 0.25
MAX_SPEED = 1.0
LEASE_SECONDS = 0.35
DIRECTIONS = {'forward': (1.0, 0.0), 'backward': (-1.0, 0.0),
              'left': (0.0, 1.0), 'right': (0.0, -1.0), 'stop': (0.0, 0.0)}
LINEAR_ACCEL, LINEAR_DECEL = 0.3, 0.6
ANGULAR_ACCEL, ANGULAR_DECEL = 0.6, 1.2


def valid_speed(value):
    return type(value) in (int, float) and 0 <= value <= MAX_SPEED and math.isfinite(value)


class VelocityRamp:
    def __init__(self, now=None):
        self.now = now or time.monotonic
        self.last_at = self.now()
        self.linear = self.angular = 0.0

    @staticmethod
    def approach(current, target, acceleration, deceleration, dt):
        if current * target < 0:
            target = 0.0
        rate = acceleration if abs(target) > abs(current) else deceleration
        delta = target - current
        return target if abs(delta) <= rate * dt else current + math.copysign(rate * dt, delta)

    def step(self, target, immediate=False):
        now = self.now()
        dt = max(0.0, min(0.1, now - self.last_at))
        self.last_at = now
        if immediate:
            self.linear = self.angular = 0.0
        else:
            linear, angular = target
            # Finish decelerating the outgoing axis before starting the new axis.
            if self.angular != 0 and linear != 0:
                linear = 0.0
            if self.linear != 0 and angular != 0:
                angular = 0.0
            self.linear = self.approach(self.linear, linear, LINEAR_ACCEL, LINEAR_DECEL, dt)
            self.angular = self.approach(self.angular, angular, ANGULAR_ACCEL, ANGULAR_DECEL, dt)
        return self.linear, self.angular


class JogLease:
    def __init__(self, now=None):
        self.now = now or time.monotonic
        self.sequence = -1
        self.direction = 'stop'
        self.until = 0
        self.challenges = {}
        self.linear_speed = self.angular_speed = DEFAULT_SPEED
        self.immediate = False

    def challenge(self):
        now = self.now()
        self.challenges = {key: at for key, at in self.challenges.items() if now - at < LEASE_SECONDS}
        token = secrets.token_hex(12)
        self.challenges[token] = now
        return token

    def accept(self, command, ready):
        sequence = command.get('sequence')
        direction = command.get('direction')
        if (type(sequence) is not int or sequence <= self.sequence or type(direction) is not str or direction not in DIRECTIONS
                or any(key not in ('sequence', 'direction', 'challenge', 'linearSpeed', 'angularSpeed', 'immediate') for key in command)
                or not valid_speed(command.get('linearSpeed', self.linear_speed))
                or not valid_speed(command.get('angularSpeed', self.angular_speed))
                or type(command.get('immediate', False)) is not bool
                or (command.get('immediate', False) and direction != 'stop')):
            return False
        self.sequence = sequence
        self.direction = 'stop'
        self.immediate = command.get('immediate', False)
        self.linear_speed = command.get('linearSpeed', self.linear_speed)
        self.angular_speed = command.get('angularSpeed', self.angular_speed)
        if direction == 'stop':
            return True
        at = self.challenges.get(command.get('challenge'))
        if not ready or at is None or self.now() - at >= LEASE_SECONDS:
            self.immediate = True
            return False
        self.direction = direction
        self.until = self.now() + LEASE_SECONDS
        return True

    def velocity(self, ready):
        if not ready or (self.direction != 'stop' and self.now() >= self.until):
            self.direction = 'stop'
            self.immediate = True
        linear, angular = DIRECTIONS[self.direction]
        return linear * self.linear_speed, angular * self.angular_speed


def emit(value):
    print(json.dumps({'schema_version': 1, 'jog': value}, separators=(',', ':')), flush=True)


def run(profile):
    import rclpy
    from geometry_msgs.msg import Twist
    from std_msgs.msg import Bool
    rclpy.init(args=['--ros-args', '--disable-external-lib-logs'])
    node = rclpy.create_node('amr_fleet_jog_' + str(os.getpid()),
                            enable_rosout=False, start_parameter_services=False)
    namespace = '/' + profile['rid']
    topic = namespace + '/cmd_vel_teleop'
    mode_topic = namespace + '/io/state_monitor/mode'
    publisher = node.create_publisher(Twist, topic, 1)
    mode = [None, 0]

    def receive_mode(message):
        mode[:] = [message.data, time.monotonic()]

    node.create_subscription(Bool, mode_topic, receive_mode, 1)
    lease = JogLease()
    ramp = VelocityRamp()
    buffer, last_input, last_emit, last_graph, last_publish = '', time.monotonic(), 0, 0, 0
    graph_ready, mode_source_valid, engaged = False, False, False
    try:
        while True:
            rclpy.spin_once(node, timeout_sec=0.02)
            now = time.monotonic()
            if now - last_graph >= 0.2:
                subscribers = node.get_subscriptions_info_by_topic(topic)
                sources = node.get_publishers_info_by_topic(mode_topic)
                graph_ready = (len(subscribers) == 1 and subscribers[0].node_name == 'cmd_vel_mux'
                               and subscribers[0].node_namespace == namespace
                               and subscribers[0].topic_type == 'geometry_msgs/msg/Twist')
                mode_source_valid = (len(sources) == 1 and sources[0].node_name == 'io_driver_node'
                                     and sources[0].node_namespace == namespace
                                     and sources[0].topic_type == 'std_msgs/msg/Bool')
                others = [p for p in node.get_publishers_info_by_topic(topic)
                          if p.node_name != node.get_name() or p.node_namespace != node.get_namespace()]
                graph_ready = graph_ready and not others
                last_graph = now
            ready = graph_ready
            if select.select([sys.stdin], [], [], 0)[0]:
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    break
                last_input = now
                buffer += chunk.decode('utf-8', errors='replace')
                if len(buffer) > 8192:
                    break
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    if not line.strip():
                        continue
                    try:
                        command = json.loads(line)
                        if isinstance(command, dict):
                            accepted = lease.accept(command, ready)
                            if accepted:
                                engaged = True
                    except (ValueError, TypeError):
                        lease.direction = 'stop'
                        lease.immediate = True
            if now - last_input > 8:
                break
            target = lease.velocity(ready)
            # Once used, retain zero priority until the operator closes the panel.
            # Otherwise an AUTO navigation command could resume after mux timeout.
            if engaged and now - last_publish >= 0.05:
                linear, angular = ramp.step(target, immediate=lease.immediate)
                message = Twist()
                message.linear.x, message.angular.z = linear, angular
                publisher.publish(message)
                last_publish = now
            if now - last_emit >= 0.1:
                reason = '' if ready else 'JOG 토픽과 단독 연결을 확인하세요.'
                operating_mode = ('auto' if mode[0] else 'manual') if mode_source_valid and mode[0] is not None and now - mode[1] < 0.5 else 'unknown'
                emit({'status': 'ready' if ready else 'blocked', 'reason': reason, 'topic': topic,
                      'direction': lease.direction, 'challenge': lease.challenge(), 'sequence': lease.sequence,
                      'operatingMode': operating_mode, 'linearSpeed': lease.linear_speed, 'angularSpeed': lease.angular_speed,
                      'outputLinear': ramp.linear, 'outputAngular': ramp.angular})
                last_emit = now
    finally:
        # Opening/closing a read-only panel never sends a velocity command.
        if engaged:
            for _ in range(3):
                publisher.publish(Twist())
                rclpy.spin_once(node, timeout_sec=0.02)
        node.destroy_node()
        rclpy.shutdown()


def bootstrap(source):
    # Read exactly one JSON line; avoid a buffered reader consuming later commands.
    raw = b''
    while not raw.endswith(b'\n') and len(raw) <= 4096:
        chunk = os.read(sys.stdin.fileno(), 1)
        if not chunk:
            raise ValueError('Missing profile')
        raw += chunk
    profile = json.loads(raw)['profile']
    if (not re.fullmatch(r'R_\d{3}', profile.get('rid', ''))
            or type(profile.get('domain')) is not int or not 0 <= profile['domain'] <= 232):
        raise ValueError('Invalid profile')
    matches = []
    allowed = {'PATH', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'AMENT_PREFIX_PATH', 'CMAKE_PREFIX_PATH',
               'ROS_DOMAIN_ID', 'ROS_DISTRO', 'ROS_VERSION', 'RMW_IMPLEMENTATION', 'CYCLONEDDS_URI',
               'ROS_LOCALHOST_ONLY', 'ROS_AUTOMATIC_DISCOVERY_RANGE', 'ROS_STATIC_PEERS',
               'FASTRTPS_DEFAULT_PROFILES_FILE', 'FASTDDS_DEFAULT_PROFILES_FILE', 'ROS_DISCOVERY_SERVER'}
    for folder in Path('/proc').glob('[0-9]*'):
        try:
            if folder.stat().st_uid != os.getuid():
                continue
            args = (folder / 'cmdline').read_bytes().decode().split('\0')
            if not any(os.path.basename(arg) == 'ros2' and args[i + 1:i + 4] ==
                       ['launch', 'spx_bringup', 'bringup.launch.py'] for i, arg in enumerate(args)):
                continue
            environment = dict(item.split('=', 1) for item in (folder / 'environ').read_bytes().decode().split('\0') if '=' in item)
            namespaces = [arg.split(':=', 1)[1].strip('/') for arg in args if arg.startswith(('ns:=', '__ns:='))]
            if namespaces != [profile['rid']] or environment.get('ROS_DOMAIN_ID') != str(profile['domain']):
                continue
            matches.append({key: value for key, value in environment.items() if key in allowed})
        except (OSError, UnicodeError, ValueError):
            continue
    if len(matches) != 1:
        emit({'status': 'blocked', 'reason': '등록된 로봇의 ROS2 bringup 실행을 확인하세요.'})
        return
    env = dict(os.environ)
    env.update(matches[0])
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    os.execve('/usr/bin/python3', ['python3', '-u', '-B', '-c', source + '\nrun(' + repr(profile) + ')'], env)
