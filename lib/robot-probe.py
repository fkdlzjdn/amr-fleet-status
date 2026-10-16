"""Fleet status probe and IO stream bootstrap. Explicit DO requests use guarded services."""
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path

ROS1 = {'melodic', 'noetic', 'kinetic', 'indigo'}
ROS2 = {'foxy', 'galactic', 'humble', 'iron', 'jazzy', 'kilted', 'rolling'}
KEYS = {'ROS_VERSION', 'ROS_DISTRO', 'ROS_HOSTNAME', 'ROS_NAMESPACE', 'ROS_MASTER_URI', 'ROBOT_MODEL', 'ROBOT_ID', 'RID'}

def read(path, limit=262144, binary=False):
    try:
        with open(str(path), 'rb') as stream:
            data = stream.read(limit)
        return data if binary else data.decode('utf-8', errors='replace')
    except (OSError, ValueError):
        return None

def valid_rid(value):
    found = re.search(r'(?:^|[/.:])R_(\d{3,})(?:$|[/.:])', str(value or ''))
    return 'R_' + found.group(1) if found else None

def probe():
    battery_contexts, io_contexts, bms_profiles = [], [], []
    result = {'schema_version': 1, 'hostname': socket.gethostname(), 'boot_id': (read('/proc/sys/kernel/random/boot_id') or '').strip(),
              'os': {}, 'installed_distros': [], 'process_evidence': [], 'static_evidence': [], 'errors': []}
    for line in (read('/etc/os-release') or '').splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if key in ['ID', 'VERSION_ID', 'PRETTY_NAME']: result['os'][key] = value.strip('"')
    try: result['uptime_seconds'] = float((read('/proc/uptime') or '').split()[0])
    except (ValueError, IndexError): result['uptime_seconds'] = None
    try: result['installed_distros'] = sorted(p.name for p in Path('/opt/ros').iterdir() if p.is_dir())
    except OSError: pass
    service = {'load_state': 'unknown', 'active_state': 'unknown', 'sub_state': 'unknown', 'unit_file_state': '', 'main_pid': None}
    try:
        command = ['systemctl', 'show', 'scorpion.service', '--no-pager', '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus']
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        try: stdout, stderr = process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill(); process.communicate(); raise ValueError('systemctl show timed out')
        fields = dict(line.split('=', 1) for line in stdout[:16384].splitlines() if '=' in line)
        for source, target in [('LoadState', 'load_state'), ('ActiveState', 'active_state'), ('SubState', 'sub_state'), ('UnitFileState', 'unit_file_state')]:
            if source in fields: service[target] = fields[source]
        for source, target in [('MainPID', 'main_pid'), ('ExecMainStatus', 'exit_status')]:
            if fields.get(source, '').isdigit(): service[target] = int(fields[source])
        if not fields: result['errors'].append('scorpion_state_unavailable')
    except (OSError, ValueError): result['errors'].append('scorpion_state_unavailable')
    result['scorpion'] = service
    for folder in Path('/proc').glob('[0-9]*'):
        raw = read(folder / 'cmdline', binary=True)
        if not raw: continue
        argv = [item.decode('utf-8', errors='replace') for item in raw.split(b'\0') if item]
        names = [os.path.basename(item) for item in argv]
        launch = any(name == 'ros2' and argv[i + 1:i + 3] == ['launch', 'spx_bringup'] for i, name in enumerate(names))
        # A ROS CLI inspection process is not evidence that the robot runtime is running.
        inspection = any(name in ['rostopic', 'rosparam', 'rosnode', 'rosservice', 'rosmsg', 'rossrv'] for name in names)
        inspection = inspection or any(name == 'ros2' and argv[i + 1:i + 2] not in [['launch'], ['run']] for i, name in enumerate(names))
        if inspection: continue
        distro_path = next((re.match(r'^/opt/ros/([a-z0-9_]+)/', a).group(1) for a in argv if re.match(r'^/opt/ros/([a-z0-9_]+)/', a)), None)
        native1 = any(name in ['rosmaster', 'roscore', 'roslaunch'] for name in names)
        ros2_ws = any(a.startswith('/home/') and '/ros2_ws/install/' in a for a in argv)
        ros1_ws = any(a.startswith('/home/') and '/catkin_ws/devel/lib/' in a for a in argv)
        if not (launch or native1 or distro_path or ros2_ws or ros1_ws): continue
        raw_env = read(folder / 'environ', binary=True) or b''
        env, battery_env = {}, {}
        for item in raw_env.split(b'\0'):
            if b'=' not in item: continue
            key, value = item.split(b'=', 1)
            key = key.decode(errors='replace')
            if key in KEYS: env[key] = value.decode(errors='replace')[:256]
            if key in BATTERY_ENV_KEYS: battery_env[key] = value.decode(errors='replace')[:16384]
        distro = env.get('ROS_DISTRO') or distro_path
        generation = 'ros2' if launch or env.get('ROS_VERSION') == '2' or distro in ROS2 or ros2_ws else 'ros1' if native1 or env.get('ROS_VERSION') == '1' or distro in ROS1 or ros1_ws else None
        if not generation: continue
        try:
            executable = os.readlink(str(folder / 'exe'))
        except OSError:
            executable = ''
        battery_contexts.append({'generation': generation, 'env': battery_env,
                                 'python': executable if re.fullmatch(r'python3(?:\.\d+)?', os.path.basename(executable)) else '/usr/bin/python3'})
        if any(name in ('io_driver_node', 'io_driver_node_exe') for name in names):
            io_namespace = next((a.split(':=', 1)[1] for a in argv if a.startswith('__ns:=')), env.get('ROS_NAMESPACE') or '/')
            io_contexts.append(dict(battery_contexts[-1], namespace=io_namespace))
        if any(name in ('bms_driver_node', 'bms_driver_node_exe', 'battery_driver_node') for name in names):
            maps = read(folder / 'maps', limit=1048576) or ''
            plugins = set(re.findall(r'/lib(spx_bms_[A-Za-z0-9_]+_plugin)\.so', maps))
            if plugins == {'spx_bms_slec_plugin'}:
                bms_namespace = next((a.split(':=', 1)[1] for a in argv if a.startswith('__ns:=')), env.get('ROS_NAMESPACE') or '/')
                bms_name = next((a.split(':=', 1)[1] for a in argv if a.startswith('__node:=')), 'bms_driver_node')
                bms_profiles.append({'publisher': bms_namespace.rstrip('/') + '/' + bms_name,
                                     'pid': int(folder.name), 'plugin': 'spx_bms_slec_plugin', 'current_sign': 'positive_charging'})
        model = next((a.split(':=', 1)[1] for a in argv if re.fullmatch(r'robot_model:=[A-Za-z0-9_.-]+', a)), env.get('ROBOT_MODEL'))
        namespace = next((a.split(':=', 1)[1] for a in argv if a.startswith('ns:=')), None)
        rid = valid_rid(namespace)
        if not rid:
            rid = next((valid_rid(env.get(key)) for key in ['RID', 'ROBOT_ID', 'ROS_NAMESPACE', 'ROS_HOSTNAME', 'ROS_MASTER_URI'] if valid_rid(env.get(key))), None)
        result['process_evidence'].append({'pid': int(folder.name), 'generation': generation, 'distro': distro,
            'model': model if model and re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', model) else None,
            'rid': rid, 'bringup': launch, 'namespace': namespace, 'source': 'ros2_launch' if launch else 'process_environment'})
        if len(result['process_evidence']) >= 256: break
    # Read configuration text only. Never source or execute startup scripts.
    home = Path.home()
    for path in [home / 'scorpion.sh', home / '.bashrc', home / '.profile', Path('/etc/environment')]:
        text = read(path)
        if text is None: continue
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith('#'): continue
            assignment = re.match(r"^(?:export\s+)?(ROBOT_MODEL|ROS_HOSTNAME|ROBOT_ID|RID|ROS_DISTRO|ROS_VERSION)\s*=\s*['\"]?([A-Za-z0-9_.-]+)['\"]?(?:\s*(?:#.*)?)$", stripped)
            if assignment:
                result['static_evidence'].append({'key': assignment.group(1), 'value': assignment.group(2), 'source': str(path)})
            setup = re.search(r'\b(?:source|\.)\s+/opt/ros/([a-z0-9_]+)/setup\.(?:bash|sh)', stripped)
            if setup: result['static_evidence'].append({'key': 'ROS_DISTRO', 'value': setup.group(1), 'source': str(path)})
            if len(result['static_evidence']) >= 80: break
    result['process_scan_complete'] = True
    result['io_driver'] = {'running': bool(io_contexts)}
    rids = set(item['rid'] for item in result['process_evidence'] if item.get('rid'))
    if not rids:
        rids = set(item['value'] for item in result['static_evidence']
                   if item['key'] in ('RID', 'ROBOT_ID', 'ROS_HOSTNAME') and re.fullmatch(r'R_\d{3,}', item['value']))
    if not rids and valid_rid(result['hostname']):
        rids = {valid_rid(result['hostname'])}
    if globals().get('PROBE_MODE') == 'battery_stream':
        if len(rids) > 1:
            battery_stream_emit({'status': 'ambiguous'})
        else:
            stream_battery(battery_contexts, next(iter(rids), None), bms_profiles, BATTERY_WORKER_SOURCE)
        return None
    if globals().get('PROBE_MODE') == 'io_stream':
        if len(rids) > 1:
            io_emit({'status': 'ambiguous'})
        else:
            stream_io(io_contexts, next(iter(rids), None), IO_WORKER_SOURCE)
        return None
    if globals().get('PROBE_MODE') == 'io':
        result['io'] = ({'status': 'ambiguous'} if len(rids) > 1 else
                        collect_io(io_contexts, next(iter(rids), None), IO_WORKER_SOURCE))
    else:
        result['battery'] = ({'status': 'ambiguous'} if len(rids) > 1 else
                             collect_battery(battery_contexts, next(iter(rids), None), BATTERY_WORKER_SOURCE))
        matching = [profile for profile in bms_profiles if profile['publisher'] == result['battery'].get('publisher')]
        if len(matching) == 1:
            result['battery']['current_profile'] = matching[0]
    result['collected_at_epoch'] = time.time()
    return result

if __name__ == '__main__':
    payload = probe()
    if payload is not None:
        print(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
