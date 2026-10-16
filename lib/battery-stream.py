"""Read-only battery subscriptions with an SSH stdin lease. No output services."""
import select
from pathlib import Path


def battery_stream_emit(battery):
    print(json.dumps({'schema_version': 1, 'battery': battery}, allow_nan=False, separators=(',', ':')), flush=True)


def live_current_profile(profiles, publisher):
    matched = [profile for profile in profiles if profile.get('publisher') == publisher]
    if len(matched) != 1:
        return None
    profile = matched[0]
    try:
        folder = Path('/proc') / str(profile['pid'])
        args = [a.decode(errors='replace') for a in (folder / 'cmdline').read_bytes().split(b'\0') if a]
        namespace = next((a.split(':=', 1)[1] for a in args if a.startswith('__ns:=')), '/')
        name = next((a.split(':=', 1)[1] for a in args if a.startswith('__node:=')), 'bms_driver_node')
        with (folder / 'maps').open() as stream:
            plugins = set(re.findall(r'/lib(spx_bms_[A-Za-z0-9_]+_plugin)\.so', stream.read(1048576)))
        if plugins == {'spx_bms_slec_plugin'} and namespace.rstrip('/') + '/' + name == publisher:
            return profile
    except (OSError, KeyError):
        pass
    return None


def ros2_battery_stream(rid, profiles, emit, alive):
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import BatteryState
    from std_msgs.msg import Bool
    rclpy.init(args=['--ros-args', '--disable-external-lib-logs'])
    node = rclpy.create_node('amr_fleet_battery_live_' + str(os.getpid()), enable_rosout=False, start_parameter_services=False)
    latest, io_latest = [], []
    subscription, io_subscription, topic, io_topic = None, None, None, None
    revision, last_revision, last_emit, last_discovery, last_status = 0, 0, 0, 0, None
    started, topic_error, io_error = time.monotonic(), 'no_topic', 'no_topic'
    profile, publisher = None, None

    def receive(message):
        nonlocal revision
        revision += 1; latest[:] = [(message, time.monotonic())]

    def receive_io(message):
        io_latest[:] = [(message, time.monotonic())]

    try:
        while alive():
            rclpy.spin_once(node, timeout_sec=0.02)
            now = time.monotonic()
            if now - last_discovery >= 0.5:
                last_discovery = now
                topics = node.get_topic_names_and_types()
                candidate, topic_error = battery_topic(topics, rid)
                io_candidate, io_error = charging_topic(topics, rid)
                if candidate and subscription is None:
                    topic = candidate; subscription = node.create_subscription(BatteryState, topic, receive, qos_profile_sensor_data)
                if io_candidate and io_subscription is None:
                    io_topic = io_candidate; io_subscription = node.create_subscription(Bool, io_topic, receive_io, qos_profile_sensor_data)
                if candidate != topic:
                    latest.clear()
                if io_candidate != io_topic:
                    io_latest.clear()
                if topic and candidate == topic and not topic_error:
                    publishers = node.get_publishers_info_by_topic(topic)
                    if len(publishers) != 1:
                        topic_error = 'ambiguous'; latest.clear()
                    else:
                        publisher = publishers[0].node_namespace.rstrip('/') + '/' + publishers[0].node_name
                        profile = live_current_profile(profiles, publisher)
                        if any(p.get('publisher') == publisher for p in profiles) and profile is None:
                            emit({'status': 'context_changed'}); return
            status = topic_error
            result = None
            if not topic_error and latest and now - latest[0][1] <= 1.0:
                if revision != last_revision and now - last_emit >= 0.2:
                    message = latest[0][0]
                    publishers = node.get_publishers_info_by_topic(topic)
                    current_publisher = publishers[0].node_namespace.rstrip('/') + '/' + publishers[0].node_name if len(publishers) == 1 else None
                    if current_publisher != publisher:
                        emit({'status': 'context_changed'}); return
                    values = {key: getattr(message, key) for key in ('percentage', 'voltage', 'current', 'present', 'power_supply_status')}
                    result = battery_sample(values, topic, 'ros2', message.header.stamp.sec + message.header.stamp.nanosec / 1e9)
                    if result['message_age_seconds'] is not None and result['message_age_seconds'] > 2:
                        result['status'] = 'stale'
                    result['publisher'] = publisher
                    if profile:
                        result['current_profile'] = profile
                    charge = {'status': io_error or 'timeout', 'topic': io_topic}
                    if not io_error and io_latest and now - io_latest[0][1] <= 1.0:
                        owners = node.get_publishers_info_by_topic(io_topic)
                        namespace = io_topic[:-len('/io/state_monitor/charging')] or '/'
                        if len(owners) == 1 and owners[0].node_name == 'io_driver_node' and owners[0].node_namespace == namespace:
                            charge.update(status='observed', charging=io_latest[0][0].data, message_age_seconds=now - io_latest[0][1])
                        else:
                            charge['status'] = 'ambiguous'
                    result['io_charging'] = charge
                    last_revision = revision
                else:
                    continue
            elif now - started < 3.0:
                status = 'loading'
            else:
                status = topic_error or 'timeout'
            if result is not None or status != last_status or now - last_emit >= 1.0:
                result = result or {'status': status, 'topic': topic}
                emit(result); last_emit = now; last_status = result['status']
    finally:
        node.destroy_node(); rclpy.shutdown()


def battery_stream_worker(rid, profiles):
    lease = [time.monotonic()]

    def alive():
        if select.select([sys.stdin], [], [], 0)[0]:
            if not os.read(sys.stdin.fileno(), 4096):
                return False
            lease[0] = time.monotonic()
        return time.monotonic() - lease[0] < 8

    try:
        ros2_battery_stream(rid, profiles, battery_stream_emit, alive)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except ImportError:
        battery_stream_emit({'status': 'runtime_unavailable'})
    except Exception:
        battery_stream_emit({'status': 'unavailable'})


def stream_battery(contexts, rid, profiles, source):
    groups = {}
    for context in contexts:
        env = context['env']; key = (context['generation'], env.get('ROS_DOMAIN_ID', '0'))
        if key not in groups or len(env.get('PYTHONPATH', '')) > len(groups[key]['env'].get('PYTHONPATH', '')):
            groups[key] = context
    if len(groups) != 1:
        battery_stream_emit({'status': 'ambiguous' if groups else 'not_running'}); return
    context = next(iter(groups.values()))
    if context['generation'] != 'ros2':
        battery_stream_emit({'status': 'unsupported'}); return
    env = dict(os.environ); env.update(context['env']); env['PYTHONDONTWRITEBYTECODE'] = '1'
    python = context.get('python') or '/usr/bin/python3'
    code = source + '\nbattery_stream_worker(' + repr(rid) + ',' + repr(profiles) + ')'
    try:
        os.execve(python, [python, '-u', '-B', '-c', code], env)
    except OSError:
        battery_stream_emit({'status': 'runtime_unavailable'})
