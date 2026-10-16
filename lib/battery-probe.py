"""Bounded subscription to existing BatteryState publishers; never opens a device."""
import json
import math
import os
import re
import socket
import struct
import subprocess
import sys
import time
import xmlrpc.client

BATTERY_ENV_KEYS = {
    'PATH', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'AMENT_PREFIX_PATH', 'CMAKE_PREFIX_PATH',
    'ROS_MASTER_URI', 'ROS_DOMAIN_ID', 'ROS_LOCALHOST_ONLY', 'ROS_DISTRO', 'ROS_VERSION',
    'RMW_IMPLEMENTATION', 'CYCLONEDDS_URI', 'FASTRTPS_DEFAULT_PROFILES_FILE',
    'FASTDDS_DEFAULT_PROFILES_FILE', 'ROS_DISCOVERY_SERVER', 'ROS_AUTOMATIC_DISCOVERY_RANGE',
    'ROS_STATIC_PEERS', 'RMW_FASTRTPS_USE_QOS_FROM_XML', 'RMW_IMPLEMENTATION',
}


def battery_topic(topics, rid):
    candidates = sorted(set(name for name, types in topics
                            if any(t in ('sensor_msgs/BatteryState', 'sensor_msgs/msg/BatteryState') for t in types)
                            and name.endswith('/battery_state')))
    if rid:
        scoped = [name for name in candidates if rid in name.split('/')]
        candidates = scoped or [name for name in candidates if not re.search(r'/R_\d+(?:/|$)', name)]
    elif any(re.search(r'/R_\d+(?:/|$)', name) for name in candidates):
        return None, 'identity_unknown'
    if len(candidates) != 1:
        return None, 'ambiguous' if candidates else 'no_topic'
    return candidates[0], None


def battery_sample(values, topic, source, stamp=0, latched=False):
    now = time.time()
    age = now - stamp if stamp > 0 else None
    result = {'status': 'observed', 'topic': topic, 'source': source,
              'observed_at_epoch': now, 'message_age_seconds': age}
    for key in ('percentage', 'voltage', 'current'):
        value = values.get(key)
        result[key] = value if isinstance(value, (float, int)) and math.isfinite(value) else None
    result['power_supply_status'] = values.get('power_supply_status')
    result['present'] = values.get('present')
    if age is not None and (age > 90 or age < -5) or latched and age is None:
        result['status'] = 'stale'
    elif values.get('present') is False:
        result['status'] = 'not_present'
    elif result['percentage'] is None or not 0 <= result['percentage'] <= 1:
        result['status'] = 'invalid'
    return result


def ros1_battery(rid):
    # Read through XML-RPC + TCPROS without ROS imports, nodes, logs or master registration.
    socket.setdefaulttimeout(1.0)
    caller = '/amr_fleet_battery_read'
    master = xmlrpc.client.ServerProxy(os.environ.get('ROS_MASTER_URI') or 'http://127.0.0.1:11311')
    code, _, published = master.getPublishedTopics(caller, '')
    if code != 1:
        return {'status': 'unavailable'}
    topic, error = battery_topic([(name, [kind]) for name, kind in published], rid)
    if error:
        return {'status': error}
    code, _, state = master.getSystemState(caller)
    if code != 1:
        return {'status': 'unavailable', 'topic': topic}
    publishers = next((nodes for name, nodes in state[0] if name == topic), [])
    if len(publishers) != 1:
        return {'status': 'ambiguous', 'topic': topic}
    code, _, uri = master.lookupNode(caller, publishers[0])
    if code != 1:
        return {'status': 'unavailable', 'topic': topic}
    code, _, protocol = xmlrpc.client.ServerProxy(uri).requestTopic(caller, topic, [['TCPROS']])
    if code != 1 or protocol[0] != 'TCPROS':
        return {'status': 'unavailable', 'topic': topic}

    def frame(value):
        return struct.pack('<I', len(value)) + value

    with socket.create_connection((protocol[1], protocol[2]), timeout=1.5) as stream:
        stream.settimeout(1.5)

        def receive(size):
            if size > 65536:
                raise ValueError('battery frame too large')
            data = b''
            while len(data) < size:
                chunk = stream.recv(size - len(data))
                if not chunk:
                    raise ValueError('battery connection closed')
                data += chunk
            return data

        def packet():
            return receive(struct.unpack('<I', receive(4))[0])

        fields = {'callerid': caller, 'topic': topic, 'type': 'sensor_msgs/BatteryState',
                  'md5sum': '*', 'tcp_nodelay': '1'}
        stream.sendall(frame(b''.join(frame((k + '=' + v).encode()) for k, v in fields.items())))
        raw_header, header = packet(), {}
        while raw_header:
            size = struct.unpack_from('<I', raw_header)[0]
            key, value = raw_header[4:4 + size].decode().split('=', 1)
            header[key] = value
            raw_header = raw_header[4 + size:]
        if header.get('type') != 'sensor_msgs/BatteryState' or 'error' in header:
            raise ValueError('unexpected battery type')
        data, offset, values, stamp = packet(), 0, {}, 0
        # Use the publisher's definition: Melodic/Noetic differ in optional fields.
        for line in header.get('message_definition', '').split('\n===', 1)[0].splitlines():
            line = line.split('#', 1)[0].strip()
            if not line or '=' in line:
                continue
            kind, name = line.split()
            if kind in ('Header', 'std_msgs/Header'):
                _, secs, nsecs, length = struct.unpack_from('<IIII', data, offset)
                stamp = secs + nsecs / 1e9
                offset += 16 + length
            elif kind == 'float32':
                values[name] = struct.unpack_from('<f', data, offset)[0]
                offset += 4
            elif kind in ('uint8', 'bool'):
                values[name] = bool(data[offset]) if kind == 'bool' else data[offset]
                offset += 1
            else:
                break
            if name == 'present':
                break
        return battery_sample(values, topic, 'ros1', stamp, header.get('latching') == '1')


def charging_topic(topics, rid):
    candidates = sorted(set(name for name, types in topics
                            if 'std_msgs/msg/Bool' in types and name.endswith('/io/state_monitor/charging')))
    if rid:
        scoped = [name for name in candidates if rid in name.split('/')]
        candidates = scoped or [name for name in candidates if not re.search(r'/R_\d+(?:/|$)', name)]
    elif any(re.search(r'/R_\d+(?:/|$)', name) for name in candidates):
        return None, 'identity_unknown'
    return (candidates[0], None) if len(candidates) == 1 else (None, 'ambiguous' if candidates else 'no_topic')


def ros2_battery(rid):
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import BatteryState
    from std_msgs.msg import Bool
    rclpy.init(args=['--ros-args', '--disable-external-lib-logs'])
    node = rclpy.create_node('amr_fleet_battery_read_' + str(os.getpid()),
                            enable_rosout=False, start_parameter_services=False)
    try:
        deadline, subscription, samples, topic, error = time.monotonic() + 3.0, None, [], None, 'no_topic'
        charge_subscription, charge_samples, charge_name, charge_error, first_battery = None, [], None, 'no_topic', None
        def receive_charge(message):
            charge_samples[:] = [(message, time.monotonic())]
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.05)
            topics = node.get_topic_names_and_types()
            candidate, error = battery_topic(topics, rid)
            charging_candidate, charge_error = charging_topic(topics, rid)
            if subscription is None and candidate:
                topic = candidate
                subscription = node.create_subscription(BatteryState, topic, samples.append, qos_profile_sensor_data)
            if charge_subscription is None and charging_candidate:
                charge_name = charging_candidate
                charge_subscription = node.create_subscription(Bool, charge_name, receive_charge, qos_profile_sensor_data)
            if samples and first_battery is None:
                first_battery = time.monotonic()
            if samples and (charge_samples or time.monotonic() - first_battery >= 0.3):
                break
        if samples:
            if error or candidate != topic or len(node.get_publishers_info_by_topic(topic)) != 1:
                result = {'status': error or 'ambiguous'}
            else:
                message = samples[-1]
                values = {key: getattr(message, key) for key in
                          ('percentage', 'voltage', 'current', 'present', 'power_supply_status')}
                result = battery_sample(values, topic, 'ros2', message.header.stamp.sec + message.header.stamp.nanosec / 1e9)
                publisher = node.get_publishers_info_by_topic(topic)[0]
                if hasattr(publisher, 'node_namespace') and hasattr(publisher, 'node_name'):
                    result['publisher'] = publisher.node_namespace.rstrip('/') + '/' + publisher.node_name
        else:
            result = {'status': 'timeout' if subscription is not None else error, 'topic': topic}
        charge = {'status': 'timeout' if charge_subscription is not None else charge_error, 'topic': charge_name}
        if charge_samples:
            publishers = node.get_publishers_info_by_topic(charge_name)
            namespace = charge_name[:-len('/io/state_monitor/charging')] or '/'
            if (charge_error or charging_candidate != charge_name or len(publishers) != 1
                    or publishers[0].node_name != 'io_driver_node' or publishers[0].node_namespace != namespace):
                charge['status'] = 'ambiguous'
            elif type(charge_samples[-1][0].data) is bool:
                charge.update(status='observed', charging=charge_samples[-1][0].data,
                              observed_at_epoch=time.time(), message_age_seconds=time.monotonic() - charge_samples[-1][1])
        result['io_charging'] = charge
        return result
    finally:
        node.destroy_node()
        rclpy.shutdown()


def battery_worker():
    try:
        request = json.loads(sys.stdin.read())
        result = ros2_battery(request.get('rid')) if request['generation'] == 'ros2' else ros1_battery(request.get('rid'))
    except ImportError:
        result = {'status': 'runtime_unavailable'}
    except (socket.timeout, TimeoutError):
        result = {'status': 'timeout'}
    except Exception:
        result = {'status': 'unavailable'}
    print(json.dumps(result, allow_nan=False, separators=(',', ':')))


def collect_battery(contexts, rid, worker_source):
    if not contexts:
        return {'status': 'not_running'}
    # Never guess between simultaneously running ROS masters/domains.
    groups = {}
    for context in contexts:
        env = context['env']
        key = (context['generation'], env.get('ROS_MASTER_URI') if context['generation'] == 'ros1'
               else env.get('ROS_DOMAIN_ID', '0'))
        if key not in groups or len(env.get('PYTHONPATH', '')) > len(groups[key]['env'].get('PYTHONPATH', '')):
            groups[key] = context
    if len(groups) != 1:
        return {'status': 'ambiguous'}
    context = next(iter(groups.values()))
    env = dict(os.environ)
    env.update(context['env'])
    # Avoid bytecode and ROS external log file creation on the robot.
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    try:
        process = subprocess.Popen([context.get('python') or '/usr/bin/python3', '-B', '-c', worker_source + '\nbattery_worker()'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   universal_newlines=True, env=env)
        try:
            stdout, _ = process.communicate(json.dumps({'generation': context['generation'], 'rid': rid}), timeout=4.5)
        except subprocess.TimeoutExpired:
            process.kill(); process.communicate()
            return {'status': 'timeout'}
        if process.returncode != 0 or len(stdout) > 16384:
            return {'status': 'runtime_unavailable'}
        return json.loads(stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError):
        return {'status': 'runtime_unavailable'}
