'use strict';
const DISTROS = { melodic: 'ros1', noetic: 'ros1', kinetic: 'ros1', indigo: 'ros1', foxy: 'ros2', galactic: 'ros2', humble: 'ros2', iron: 'ros2', jazzy: 'ros2', kilted: 'ros2', rolling: 'ros2' };
const names = { noetic: 'Noetic', melodic: 'Melodic', jazzy: 'Jazzy', humble: 'Humble', foxy: 'Foxy' };
const errors = {
  auth_failed: 'SSH 인증 실패 · 계정 또는 인증 키/비밀번호를 확인하세요.',
  host_key_unknown: 'SSH 호스트키 미등록 · 서버의 known_hosts에 신뢰할 키를 등록해야 합니다.',
  host_key_mismatch: 'SSH 호스트키 불일치 · 기존 등록 키와 다릅니다.',
  credentials_invalid: '서버 SSH 인증 설정을 확인할 수 없습니다.',
  connection_refused: '접속 포트가 연결을 거부했습니다. 전원 OFF로 단정할 수 없습니다.',
  no_route: '네트워크 경로 없음 · 서버에서 대상 IP에 도달하지 못했습니다.',
  timeout: 'SSH 연결 시간 초과 · 네트워크 또는 대상 상태를 확인하세요.',
  connection_error: 'SSH 연결이 완료되지 않았습니다.',
  probe_failed: 'SSH는 연결됐지만 상태 조회 결과를 확인하지 못했습니다.',
  probe_timeout: '읽기 조회 응답 시간 초과.',
  python_unavailable: '조회에 필요한 Python3를 확인하지 못했습니다. 로봇에 설치 작업은 하지 않았습니다.',
  probe_output_limit: '조회 출력이 허용된 크기를 초과했습니다.'
};
const unique = values => [...new Set(values.filter(Boolean))];
const family = values => { const set = unique(values); return set.length > 1 ? 'both' : set[0] || 'unknown'; };
function normalizeBattery(data, now = new Date().toISOString()) {
  const statuses = ['observed', 'pending', 'not_running', 'no_topic', 'ambiguous', 'identity_unknown', 'timeout', 'runtime_unavailable', 'not_present', 'invalid', 'stale', 'unavailable'];
  let status = statuses.includes(data?.status) ? data.status : 'unavailable';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  if (status === 'observed' && (!finite(data.percentage) || data.percentage < 0 || data.percentage > 1)) status = 'invalid';
  if (['observed', 'invalid'].includes(status) && finite(data.message_age_seconds) && (data.message_age_seconds > 90 || data.message_age_seconds < -5)) status = 'stale';
  if (['observed', 'invalid'].includes(status) && data.present === false) status = 'not_present';
  const observed = status === 'observed';
  const sampleFresh = ['observed', 'invalid'].includes(status);
  const powerSupplyStatus = sampleFresh && [1, 2, 3, 4].includes(data.power_supply_status) ? data.power_supply_status : null;
  const io = data?.io_charging;
  const ioFresh = io?.status === 'observed' && typeof io.charging === 'boolean' && finite(io.message_age_seconds)
    && io.message_age_seconds >= -5 && io.message_age_seconds <= 2;
  const bmsCharging = powerSupplyStatus === null ? null : powerSupplyStatus === 1;
  const ioCharging = ioFresh ? io.charging : null;
  const currentSign = data?.current_profile?.plugin === 'spx_bms_slec_plugin' && data.current_profile.current_sign === 'positive_charging' ? 'positive_charging' : null;
  const current = sampleFresh && finite(data.current) ? data.current : null;
  const currentThresholdA = 0.1; // Display deadband, not a BMS protection threshold.
  let charging = bmsCharging, chargingSource = bmsCharging !== null ? 'battery_state' : null;
  let chargingState = powerSupplyStatus === 1 ? 'charging' : powerSupplyStatus === 2 ? 'discharging' : powerSupplyStatus === 4 ? 'full' : powerSupplyStatus === 3 ? 'idle' : 'unknown';
  if (currentSign && current !== null) {
    charging = current > currentThresholdA; chargingSource = 'battery_current';
    chargingState = charging ? 'charging' : current < -currentThresholdA ? 'discharging' : powerSupplyStatus === 4 ? 'full' : 'idle';
  } else if (ioCharging === true && bmsCharging !== true) {
    charging = null; chargingSource = 'io_state_monitor'; chargingState = bmsCharging === false ? 'conflict' : 'signal';
  } else if (bmsCharging === null && ioFresh) {
    chargingSource = 'io_state_monitor'; chargingState = 'signal';
  }
  const chargingConflict = (bmsCharging !== null && charging !== null && bmsCharging !== charging)
    || (ioFresh && charging !== null && ioCharging !== charging) || chargingState === 'conflict';
  return { status, percent: observed ? Math.round(data.percentage * 1000) / 10 : null,
    voltage: sampleFresh && finite(data.voltage) && data.voltage > 0 ? data.voltage : null,
    current, currentSign, currentThresholdA: currentSign ? currentThresholdA : null,
    charging, chargingState, chargingSource, chargingConflict,
    ioCharging: { status: ioFresh ? 'observed' : io?.status === 'observed' ? 'stale' : io?.status || 'unavailable',
      charging: ioCharging, topic: typeof io?.topic === 'string' ? io.topic.slice(0, 512) : null,
      observedAt: ioFresh ? now : null },
    powerSupplyStatus,
    topic: typeof data?.topic === 'string' ? data.topic.slice(0, 512) : null,
    source: ['ros1', 'ros2'].includes(data?.source) ? data.source : null,
    messageAgeSeconds: finite(data?.message_age_seconds) ? data.message_age_seconds : null,
    observedAt: observed || powerSupplyStatus !== null || ioFresh ? now : null };
}
function initialRobot(entry, index) {
  return { id: entry.expected_rid, plannedRid: /^R_\d{3}$/.test(entry.expected_rid) ? entry.expected_rid : null, number: index + 1, ip: entry.ip, port: entry.ssh_port, observedRid: null,
    reachability: 'unknown', ssh: 'pending', model: null, modelLabel: '미확인', configuredRos: 'unknown', activeRos: 'unknown', distro: null,
    service: 'unknown', serviceEnabled: null, bringup: 'unknown', ioDriverStatus: 'unknown', battery: normalizeBattery({ status: 'pending' }), quality: 'pending', needsAttention: false,
    issues: [], observedAt: null, checkedAt: null, evidence: '첫 읽기 조회 대기', history: [], previous: null, sources: {}, details: {} };
}
function normalize(entry, index, response, previous, now = new Date().toISOString()) {
  const robot = initialRobot(entry, index); robot.checkedAt = now; robot.port = response.port || entry.ssh_port;
  robot.history = previous?.history || []; robot.previous = previous?.previous || null;
  if (previous?.observedAt && (previous.quality === 'observed' || previous.quality === 'partial')) robot.previous = {
    model: previous.model, modelLabel: previous.modelLabel, configuredRos: previous.configuredRos, distro: previous.distro,
    observedRid: previous.observedRid, observedAt: previous.observedAt, battery: previous.battery
  };
  if (!response.ok) {
    robot.battery = normalizeBattery();
    robot.reachability = response.reached || response.sshConnected ? 'reachable' : ['timeout', 'no_route'].includes(response.error) ? 'unreachable' : 'unknown';
    robot.ssh = response.sshConnected ? 'probe_failed' : response.error || 'unknown';
    robot.quality = response.sshConnected ? 'partial' : 'unknown';
    robot.needsAttention = robot.reachability === 'reachable' || ['credentials_invalid', 'host_key_mismatch'].includes(response.error);
    robot.issues = [errors[response.error] || '상태를 확인할 수 없습니다.'];
    robot.evidence = response.sshConnected ? 'SSH 인증 성공 · 상세 조회 미완료' : 'SSH 접속 결과';
    robot.details = { errorCode: response.error, fingerprint: response.fingerprint, attempts: response.attempts };
    return robot;
  }
  const data = response.payload;
  robot.ioDriverStatus = data.process_scan_complete === true && typeof data.io_driver?.running === 'boolean'
    ? data.io_driver.running ? 'running' : 'stopped' : 'unknown';
  robot.battery = normalizeBattery(data.battery, now);
  robot.reachability = 'reachable'; robot.ssh = 'connected'; robot.observedAt = now;
  robot.quality = data.errors?.length ? 'partial' : 'observed';
  const processes = data.process_evidence || [], staticEvidence = data.static_evidence || [];
  const roots = processes.filter(item => item.bringup);
  const activeGenerations = unique(processes.map(item => item.generation));
  const liveDistros = unique(processes.map(item => item.distro));
  const staticDistros = unique(staticEvidence.filter(item => item.key === 'ROS_DISTRO').map(item => item.value));
  const staticGenerations = unique([...staticDistros.map(d => DISTROS[d]), ...staticEvidence.filter(item => item.key === 'ROS_VERSION').map(item => item.value === '1' ? 'ros1' : item.value === '2' ? 'ros2' : null)]);
  robot.activeRos = activeGenerations.length ? family(activeGenerations) : data.process_scan_complete ? 'stopped' : 'unknown';
  robot.configuredRos = activeGenerations.length ? family(activeGenerations) : family(staticGenerations);
  robot.distro = (liveDistros.length ? liveDistros : staticDistros).map(name => names[name] || name).join(' / ') || null;
  const sourceModels = roots.some(p => p.model) ? roots.filter(p => p.model).map(p => ({ value: p.model, source: `${p.generation === 'ros1' ? 'ROS1' : 'ROS2'} bringup PID ${p.pid}` }))
    : processes.some(p => p.model) ? processes.filter(p => p.model).map(p => ({ value: p.model, source: `실행 프로세스 PID ${p.pid}` }))
    : staticEvidence.filter(p => p.key === 'ROBOT_MODEL').map(p => ({ value: p.value, source: p.source }));
  const models = unique(sourceModels.map(item => item.value));
  robot.model = models.length === 1 ? models[0] : null;
  robot.modelLabel = robot.model ? robot.model.replace(/_ros2$/, '').toUpperCase() : models.length > 1 ? '설정 충돌' : '미확인';
  const observedRids = unique((roots.some(p => p.rid) ? roots : processes).map(p => p.rid));
  const staticRids = unique(staticEvidence.filter(item => ['RID', 'ROBOT_ID', 'ROS_HOSTNAME'].includes(item.key)).map(item => /^R_\d{3,}$/.test(item.value) ? item.value : null));
  const rids = observedRids.length ? observedRids : staticRids.length ? staticRids : /^R_\d{3,}$/.test(data.hostname) ? [data.hostname] : [];
  robot.observedRid = rids.length === 1 ? rids[0] : null;
  const service = data.scorpion || {};
  robot.service = service.load_state === 'not-found' ? 'not_found' : service.active_state === 'failed' ? 'failed'
    : service.active_state === 'active' && service.sub_state === 'running' ? 'running'
    : service.active_state === 'active' && service.sub_state === 'exited' ? 'exited'
    : service.active_state === 'activating' ? 'activating' : service.active_state === 'deactivating' ? 'deactivating'
    : service.load_state !== 'unknown' && service.active_state === 'inactive' ? 'inactive' : 'unknown';
  robot.serviceEnabled = /^enabled/.test(service.unit_file_state || '') ? true : service.unit_file_state === 'disabled' ? false : null;
  robot.bringup = roots.length ? 'running' : data.process_scan_complete ? 'stopped' : 'unknown';
  if (robot.observedRid && robot.plannedRid && robot.observedRid !== robot.plannedRid) robot.issues.push(`RID 불일치 · 계획 ${robot.id} / 관측 ${robot.observedRid}`);
  if (rids.length > 1) robot.issues.push('실행 중인 RID가 여러 개입니다. 상세 근거를 확인하세요.');
  if (models.length > 1) robot.issues.push('모델 정보가 충돌합니다.');
  if (robot.service === 'failed') robot.issues.push('scorpion 서비스 실패');
  if (robot.service === 'inactive' && robot.activeRos !== 'ros2') robot.issues.push('scorpion 서비스 정지');
  if (robot.activeRos === 'stopped' && robot.configuredRos !== 'unknown') robot.issues.push('ROS 설정은 있지만 실행 프로세스가 확인되지 않습니다.');
  if (robot.activeRos === 'both') robot.issues.push('ROS1과 ROS2 실행 프로세스가 함께 확인됐습니다.');
  if (data.errors?.length) robot.issues.push('일부 읽기 조회를 완료하지 못했습니다.');
  robot.needsAttention = robot.issues.length > 0;
  robot.evidence = roots.length ? 'SSH · 실제 bringup / 프로세스 / systemd 조회' : 'SSH · 프로세스 / 설정 파일 / systemd 조회';
  robot.sources = { model: sourceModels.slice(0, 8), ros: activeGenerations.length ? '실행 프로세스 환경' : staticGenerations.length ? '시작 설정의 정적 내용' : '미확인',
    rid: roots.some(p => p.rid) ? '실행 bringup namespace' : observedRids.length ? '실행 프로세스 환경' : staticRids.length ? '설정 파일' : rids.length ? 'hostname' : '미확인' };
  robot.details = { hostname: data.hostname, os: data.os, bootId: data.boot_id, uptimeSeconds: data.uptime_seconds,
    installedDistros: data.installed_distros, scorpion: service, processCount: processes.length, bringup: roots,
    activeGenerations, sourceErrors: data.errors, evidenceLevel: 'process', staticEvidence: staticEvidence.slice(0, 40) };
  return robot;
}
function summarize(robots) {
  const count = predicate => robots.filter(predicate).length;
  return { total: robots.length, reachable: count(r => r.reachability === 'reachable'), unreachable: count(r => r.reachability === 'unreachable'),
    unknown: count(r => r.reachability === 'unknown'), sshConnected: count(r => r.ssh === 'connected'), authFailed: count(r => r.ssh === 'auth_failed'),
    ros1: count(r => r.configuredRos === 'ros1'), ros2: count(r => r.configuredRos === 'ros2'), both: count(r => r.configuredRos === 'both'), rosUnknown: count(r => r.configuredRos === 'unknown'),
    serviceFailed: count(r => r.service === 'failed'), serviceStopped: count(r => r.service === 'inactive'), attention: count(r => r.needsAttention),
    pending: count(r => r.quality === 'pending') };
}
module.exports = { initialRobot, normalize, normalizeBattery, summarize, errors };
