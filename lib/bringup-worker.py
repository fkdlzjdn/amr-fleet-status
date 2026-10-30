"""Explicit ROS2 function / ROS1 scorpion lifecycle. Status performs reads only."""
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import pwd
import subprocess
import sys
import time
from pathlib import Path


class Refused(Exception):
    pass


def read_process(folder):
    try:
        if folder.stat().st_uid != os.getuid():
            return None
        args = (folder / 'cmdline').read_bytes().decode(errors='replace').split('\0')
        if not any(args):
            return None
        fields = (folder / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        env = {}
        try:
            environment = (folder / 'environ').read_bytes()
        except OSError:
            environment = b''
        for item in environment.split(b'\0'):
            key, _, value = item.partition(b'=')
            if key in [b'ROS_HOSTNAME', b'ROBOT_ID', b'RID', b'ROS_NAMESPACE', b'ROS_DOMAIN_ID']:
                env[key.decode()] = value.decode(errors='replace')
        names = [os.path.basename(arg) for arg in args]
        launch = any(name == 'ros2' and args[i + 1:i + 4] == ['launch', 'spx_bringup', 'bringup.launch.py']
                     for i, name in enumerate(names))
        ros1_launch = any(name == 'roslaunch' and args[i + 1:i + 3] == ['spx_bringup', 'bringup.launch']
                          for i, name in enumerate(names))
        rid = None
        for arg in args:
            if arg.startswith(('ns:=', '__ns:=')):
                namespace = arg.split(':=', 1)[1].strip('/')
                rid = namespace if re.fullmatch(r'R_\d{3}', namespace) else 'namespace_mismatch'
        rid = rid or next((env.get(key) for key in ['ROS_HOSTNAME', 'ROBOT_ID', 'RID'] if re.fullmatch(r'R_\d{3}', env.get(key, ''))), None)
        native = any('/ros2_ws/install/' in arg and '/lib/' in arg for arg in args)
        native = native or any('/catkin_ws/devel/lib/' in arg for arg in args)
        component = any(name.startswith('component_container') for name in names)
        vda = any('spx_vda5050_runtime' in arg for arg in args)
        try:
            groups = (folder / 'cgroup').read_text().split('/')
            managed = any(part.strip().endswith('.service') and not part.startswith('user@') for part in groups)
        except OSError:
            managed = True
        return {'pid': int(folder.name), 'start': fields[19], 'launch': launch, 'ros1_launch': ros1_launch, 'rid': rid,
                'domain': env.get('ROS_DOMAIN_ID'), 'native': native or component or vda, 'managed': managed,
                'scorpion': any(group.strip() == 'scorpion.service' for group in groups) if 'groups' in locals() else False}
    except (OSError, ValueError, IndexError):
        return None


def valid_profile(profile):
    if not isinstance(profile, dict) or not re.fullmatch(r'R_\d{3}', profile.get('rid', '')):
        raise Refused('등록된 로봇 기동 설정이 필요합니다.')
    systemd = profile.get('backend') == 'ros1_systemd'
    if profile.get('backend') not in (None, 'ros1_systemd', 'ros2_function'):
        raise Refused('지원하지 않는 기동 방식입니다.')
    if not systemd and (type(profile.get('domain')) is not int or not 0 <= profile['domain'] <= 232):
        raise Refused('ROS domain 설정을 확인하세요.')
    files = profile.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 4:
        raise Refused('등록된 기동 파일이 필요합니다.')
    home = Path.home().resolve()
    for item in files:
        if not isinstance(item, dict) or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')):
            raise Refused('기동 파일 확인 정보가 없습니다.')
        filename = home / item.get('path', '')
        resolved = filename.resolve()
        if home not in resolved.parents or not filename.is_file():
            raise Refused('기동 파일을 찾을 수 없습니다.')
        info = filename.stat()
        if info.st_uid not in (0, os.getuid()) or stat.S_IMODE(info.st_mode) & 0o022:
            raise Refused('기동 파일의 소유자와 쓰기 권한을 확인하세요.')
        if hashlib.sha256(filename.read_bytes()).hexdigest() != item['sha256']:
            raise Refused('기동 파일이 변경되었습니다. 서버의 등록 설정을 다시 확인하세요.')
    if systemd:
        if files[0]['path'] != 'scorpion.sh':
            raise Refused('등록된 scorpion.sh만 사용할 수 있습니다.')
        return home / 'scorpion.sh'
    if files[0]['path'] != '.bash_aliases':
        raise Refused('기존 bringup 함수 설정만 사용할 수 있습니다.')
    return home / '.bash_aliases'


def inspect(profile):
    if profile.get('backend') == 'ros1_systemd':
        return inspect_systemd(profile)
    processes = [p for p in (read_process(folder) for folder in Path('/proc').glob('[0-9]*')) if p]
    processes.sort(key=lambda item: item['pid'])
    roots = [p for p in processes if p['launch']]
    matching = [p for p in roots if p['rid'] == profile['rid'] and p['domain'] == str(profile['domain'])]
    leftovers = [p for p in processes if p['native'] and p['rid'] == profile['rid']]
    wrapper = None
    try:
        record = json.loads((Path.home() / '.local/state/amr-fleet-bringup/last-request.json').read_text())
        saved = record.get('wrapper') if record.get('rid') == profile['rid'] else None
        wrapper = next((p for p in processes if saved and p['pid'] == saved['pid'] and p['start'] == saved['start']), None)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    state = 'starting' if not roots and wrapper else 'stopped' if not roots and not leftovers else 'running' if len(roots) == len(matching) == 1 else 'ambiguous'
    source_error = ''
    try:
        valid_profile(profile)
    except (OSError, Refused) as error:
        source_error = str(error) if isinstance(error, Refused) else '기동 파일을 읽을 수 없습니다.'
    system_service = False
    try:
        result = subprocess.run(['/usr/bin/systemctl', 'show', 'scorpion.service', '--property=LoadState', '--value'],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, text=True)
        system_service = result.stdout.strip() != 'not-found'
    except (OSError, subprocess.TimeoutExpired):
        system_service = True
    managed = system_service or any(p['managed'] for p in roots)
    revision_data = {'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                     'roots': [(p['pid'], p['start'], p['rid'], p['domain']) for p in roots],
                     'leftovers': [(p['pid'], p['start']) for p in leftovers], 'source': source_error, 'managed': managed,
                     'wrapper': (wrapper['pid'], wrapper['start']) if wrapper else None}
    revision = hashlib.sha256(json.dumps(revision_data, sort_keys=True).encode()).hexdigest()
    reason = '서비스 관리 실행은 이 버튼으로 제어하지 않습니다.' if managed else source_error or (
        '다른 실행 또는 종료 중인 노드가 있어 대상을 확인해야 합니다.' if state == 'ambiguous' else '')
    return {'state': state, 'canStart': state == 'stopped' and not reason,
            'canStop': state == 'running' and not managed and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'),
            'reason': reason, 'revision': revision,
            'process': {'pid': matching[0]['pid'], 'start': matching[0]['start']} if len(matching) == 1 else None}


def inspect_systemd(profile):
    """Use the existing unit; never edit a unit, sudoers or robot configuration."""
    source_error = ''
    fields, process, leftovers = {}, None, []
    try:
        source = valid_profile(profile)
        cat = subprocess.run(['/usr/bin/systemctl', 'cat', 'scorpion.service'],
                             capture_output=True, timeout=2, check=True).stdout
        if hashlib.sha256(cat).hexdigest() != profile.get('unitSha256'):
            raise Refused('scorpion 서비스 정의가 변경되었습니다. 등록 설정을 확인하세요.')
        environment = Path('/etc/syscon/robot.env')
        info = environment.stat()
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise Refused('로봇 환경 파일의 소유자와 권한을 확인하세요.')
        content = environment.read_bytes()
        if hashlib.sha256(content).hexdigest() != profile.get('environmentSha256'):
            raise Refused('로봇 환경 설정이 변경되었습니다. 등록 설정을 확인하세요.')
        if not re.search(r'^ROS_HOSTNAME=[\'\"]?' + re.escape(profile['rid']) + r'[\'\"]?\s*$', content.decode(), re.M):
            raise Refused('scorpion 로봇 식별자를 확인할 수 없습니다.')
        result = subprocess.run(['/usr/bin/systemctl', 'show', 'scorpion.service',
                                 '--property=LoadState,ActiveState,SubState,MainPID,User,ExecStart,Job,KillSignal'],
                                capture_output=True, text=True, timeout=2, check=True)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if (fields.get('LoadState') != 'loaded' or fields.get('User') != pwd.getpwuid(os.getuid()).pw_name
                or fields.get('KillSignal') not in ('2', 'SIGINT')
                or not fields.get('ExecStart', '').startswith('{ path=' + str(source) + ' ; argv[]=' + str(source) + ' ;')):
            raise Refused('등록된 scorpion 실행 경로와 서비스 설정이 다릅니다.')
        processes = sorted((p for p in (read_process(folder) for folder in Path('/proc').glob('[0-9]*')) if p), key=lambda p: p['pid'])
        pid = int(fields.get('MainPID', '0'))
        process = next((p for p in processes if p['pid'] == pid), None)
        leftovers = [p for p in processes if (p.get('ros1_launch') or p['launch'] or p['native'])
                     and (p['rid'] == profile['rid'] or p.get('scorpion')) and p['pid'] != pid]
        roots = [p for p in processes if p['launch'] or p.get('ros1_launch')]
        if fields.get('ActiveState') in ('inactive', 'failed') and roots:
            raise Refused('서비스 밖에서 실행 중인 bringup이 있어 재기동을 차단합니다.')
        if fields.get('ActiveState') == 'active' and (not process or not process.get('ros1_launch')
                or process['rid'] != profile['rid'] or not process.get('scorpion')
                or any(p['pid'] != pid for p in roots)):
            raise Refused('scorpion의 실행 PID와 ROS1 로봇 식별자가 일치하지 않습니다.')
    except (OSError, ValueError, subprocess.SubprocessError, Refused) as error:
        source_error = str(error) if isinstance(error, Refused) else 'scorpion 서비스 설정을 확인할 수 없습니다.'
    active = fields.get('ActiveState')
    state = ('starting' if active == 'activating' else 'stopping' if active == 'deactivating' else
             'running' if active == 'active' else 'stopped' if active in ('inactive', 'failed') else 'ambiguous')
    if state == 'stopped' and leftovers:
        source_error = source_error or '남아 있는 로봇 노드가 있어 재기동을 차단합니다.'
    if state in ('starting', 'stopping') or fields.get('Job'):
        source_error = source_error or '서비스 기동 또는 종료가 진행 중입니다.'
    can_start, can_stop = False, False
    if not source_error and state in ('running', 'stopped'):
        action = 'start' if state == 'stopped' else 'stop'
        try:
            permission = subprocess.run(['/usr/bin/sudo', '-n', '-l', '/usr/bin/systemctl', '--no-block', action, 'scorpion.service'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
            if permission.returncode != 0:
                raise Refused('기존 scorpion 시작/정지 권한이 없습니다. 로봇 관리자 설정이 필요합니다.')
            can_start, can_stop = state == 'stopped', state == 'running'
        except (OSError, subprocess.SubprocessError, Refused) as error:
            source_error = str(error) if isinstance(error, Refused) else '서비스 제어 권한을 확인하지 못했습니다.'
    revision_data = {'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'fields': fields,
                     'process': process, 'leftovers': [(p['pid'], p['start']) for p in leftovers], 'error': source_error}
    revision = hashlib.sha256(json.dumps(revision_data, sort_keys=True).encode()).hexdigest()
    return {'state': state, 'canStart': can_start, 'canStop': can_stop, 'reason': source_error, 'revision': revision,
            'process': {'pid': process['pid'], 'start': process['start']} if process else None}


def dispatch_systemd(profile, action, current):
    # Revalidate the revision under the same durable request lock before dispatch.
    if inspect(profile)['revision'] != current['revision']:
        raise Refused('서비스 상태가 변경되었습니다. 다시 확인하세요.')
    try:
        result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/systemctl', '--no-block', action, 'scorpion.service'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return {'status': 'unconfirmed', 'message': '서비스 요청 결과를 확인하지 못했습니다. 자동 재전송하지 않습니다.', 'mayHaveApplied': True}
    if result.returncode != 0:
        return {'status': 'rejected', 'message': '기존 scorpion 서비스가 요청을 거부했습니다.', 'mayHaveApplied': False}
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        time.sleep(.3)
        latest = inspect(profile)
        if latest['state'] == ('running' if action == 'start' else 'stopped') and not latest['reason']:
            return {'status': 'confirmed', 'message': 'scorpion 실행을 확인했습니다.' if action == 'start' else 'scorpion 및 로봇 노드의 종료를 확인했습니다.', 'mayHaveApplied': True}
    return {'status': 'unconfirmed', 'message': '서비스 요청 후 상태 확인 중입니다. 자동 재전송하지 않습니다.', 'mayHaveApplied': True}


def state_directory():
    folder = Path.home() / '.local/state/amr-fleet-bringup'
    if folder.is_symlink():
        raise Refused('제어 상태 경로를 확인하세요.')
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(str(folder), 0o700)
    if folder.stat().st_uid != os.getuid():
        raise Refused('제어 상태 경로 소유자를 확인하세요.')
    return folder


def perform(profile, action, command):
    folder = state_directory()
    descriptor = os.open(str(folder / 'control.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('다른 bringup 요청을 처리 중입니다.')
        marker = folder / 'last-request.json'
        if marker.is_symlink():
            raise Refused('요청 기록 경로를 확인하세요.')
        ledger = folder / 'requests'
        if ledger.is_symlink():
            raise Refused('요청 기록 경로를 확인하세요.')
        ledger.mkdir(exist_ok=True, mode=0o700)
        for item in ledger.glob('*.json'):
            if item.is_symlink():
                raise Refused('요청 기록 경로를 확인하세요.')
            if time.time() - item.stat().st_mtime > 300:
                item.unlink()
        receipt = ledger / (command['requestId'] + '.json')
        old = {}
        if receipt.exists():
            try:
                old = json.loads(receipt.read_text())
            except (OSError, ValueError):
                raise Refused('이전 요청 기록을 확인하지 못했습니다. 다시 전송하지 않습니다.')
            if old.get('requestId') != command['requestId']:
                raise Refused('이전 요청 기록을 확인하지 못했습니다.')
        if old.get('requestId') == command['requestId']:
            if old.get('action') != action or old.get('rid') != profile['rid'] or old.get('revision') != command['expectedRevision']:
                raise Refused('같은 요청 ID를 다른 명령에 사용할 수 없습니다.')
            return old.get('result') or {'status': 'unconfirmed', 'message': '이전 요청의 결과를 확인하세요. 다시 전송하지 않았습니다.', 'mayHaveApplied': True}
        if len(list(ledger.glob('*.json'))) >= 512:
            raise Refused('최근 요청이 많습니다. 잠시 후 다시 시도하세요.')
        current = inspect(profile)
        if current['revision'] != command['expectedRevision']:
            raise Refused('실행 상태가 변경되었습니다. 상태를 새로 확인하세요.')
        if not current['canStart' if action == 'start' else 'canStop']:
            raise Refused(current['reason'] or '현재 상태에서는 이 요청을 실행할 수 없습니다.')
        record = {'requestId': command['requestId'], 'action': action, 'rid': profile['rid'], 'revision': command['expectedRevision']}
        def save():
            for destination in (receipt, marker):
                temporary = destination.with_suffix('.tmp')
                if temporary.is_symlink():
                    raise Refused('요청 기록 경로를 확인하세요.')
                fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as stream:
                    json.dump(record, stream)
                os.replace(str(temporary), str(destination))
        save()  # A duplicate may never dispatch a second action after interruption.
        if profile.get('backend') == 'ros1_systemd':
            result = dispatch_systemd(profile, action, current)
        elif action == 'start':
            source = valid_profile(profile)
            env = {key: os.environ[key] for key in ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'XDG_RUNTIME_DIR'] if key in os.environ}
            env.update({'ROS_HOSTNAME': profile['rid'], 'ROBOT_ID': profile['rid'], 'ROS_DOMAIN_ID': str(profile['domain'])})
            output = folder / 'launch-console.log'
            fd = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'ab') as log:
                child = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-c',
                                          'set -e; source "$1"; declare -F bringup >/dev/null; bringup',
                                          'amr-fleet-bringup', str(source)], stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, env=env, start_new_session=True, close_fds=True)
            wrapper = read_process(Path('/proc') / str(child.pid))
            if wrapper:
                record['wrapper'] = {'pid': wrapper['pid'], 'start': wrapper['start']}
                save()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                time.sleep(.25)
                if child.poll() is not None:
                    result = {'status': 'rejected', 'message': '기동 스크립트가 종료되었습니다. 로봇의 기동 로그를 확인하세요.', 'mayHaveApplied': True}
                    break
                latest = inspect(profile)
                if latest['state'] == 'running':
                    result = {'status': 'confirmed', 'message': 'bringup 실행 프로세스를 확인했습니다. 장치 준비 상태는 별도로 확인하세요.', 'mayHaveApplied': True}
                    break
            else:
                result = {'status': 'unconfirmed', 'message': '기동 요청 후 실행 확인을 기다리고 있습니다. 자동 재전송하지 않습니다.', 'mayHaveApplied': True}
        else:
            process = current['process']
            pidfd = os.pidfd_open(process['pid'])
            try:
                latest = inspect(profile)
                if latest['revision'] != current['revision']:
                    raise Refused('종료 대상이 변경되었습니다. 다시 확인하세요.')
                signal.pidfd_send_signal(pidfd, signal.SIGINT)
            finally:
                os.close(pidfd)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                time.sleep(.3)
                latest = inspect(profile)
                if latest['state'] == 'stopped':
                    result = {'status': 'confirmed', 'message': 'bringup 및 해당 로봇 노드의 종료를 확인했습니다.', 'mayHaveApplied': True}
                    break
            else:
                result = {'status': 'unconfirmed', 'message': '정상 종료를 요청했습니다. 아직 종료 확인 중이며 강제 종료하지 않습니다.', 'mayHaveApplied': True}
        result['observed'] = inspect(profile)
        record['result'] = result
        save()
        return result
    finally:
        os.close(descriptor)


def main():
    action = None
    try:
        raw = sys.stdin.read(8193)
        if len(raw) > 8192:
            raise Refused('요청 크기를 확인하세요.')
        request = json.loads(raw)
        profile, action = request['profile'], request['action']
        if action not in ('status', 'start', 'stop') or not re.fullmatch(r'R_\d{3}', profile.get('rid', '')):
            raise Refused('지원하지 않는 요청입니다.')
        if action == 'status':
            value = {'status': 'observed', 'observed': inspect(profile)}
        else:
            command = request['command']
            if not re.fullmatch(r'[a-f0-9]{32}', command.get('requestId', '')) or not re.fullmatch(r'[a-f0-9]{64}', command.get('expectedRevision', '')):
                raise Refused('요청 ID와 확인 상태를 점검하세요.')
            value = perform(profile, action, command)
    except Refused as error:
        value = {'status': 'rejected', 'message': str(error), 'mayHaveApplied': False}
    except Exception:
        value = {'status': 'unconfirmed' if action in ('start', 'stop') else 'unavailable',
                 'message': 'bringup 요청 결과를 확인하지 못했습니다.', 'mayHaveApplied': action in ('start', 'stop')}
    print(json.dumps({'schema_version': 1, 'bringup': value}, separators=(',', ':')))


if __name__ == '__main__':
    main()
