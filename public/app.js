'use strict';
const state = { snapshot: null, ros: 'all', model: 'all', search: '', page: 'overview', selected: null, refreshing: false, lastObserved: new Map(), initialized: false };
const rowRefresh = { until: new Map(), timer: null };
const ROW_REFRESH_MS = 1800;
const $ = id => document.getElementById(id);
const svg = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const serviceLabels = { exited: '실행 후 종료', activating: '시작 중', deactivating: '종료 중', running: '실행 중', inactive: '꺼져 있음', failed: '오류 확인', not_found: '등록 없음', unknown: '확인 안 됨' };
const rosLabels = { ros1: 'ROS1', ros2: 'ROS2', both: 'ROS1+2', unknown: '미확인', stopped: '정지' };
const reachLabels = { reachable: '응답', unreachable: '응답 없음', unknown: '미확인' };
const batteryReasons = { pending: '첫 조회 대기', not_running: '실행 중인 ROS 없음', no_topic: '배터리 토픽 없음',
  ambiguous: '배터리 정보 출처가 여러 개임', identity_unknown: '배터리 토픽의 로봇 식별 미확인', timeout: '배터리 수신 시간 초과',
  runtime_unavailable: 'ROS 배터리 읽기 환경 미확인', not_present: '배터리 연결 미확인', invalid: '잔량 값이 없거나 범위 오류',
  stale: '오래된 배터리 정보', unavailable: '배터리 정보 미확인' };
const batteryPowerLabels = { 1: '충전 중', 2: '충전 안 함 · 방전 중', 3: '충전 안 함', 4: '충전 완료' };
function batteryChargeLabel(battery) {
  if (battery?.chargingSource === 'battery_current') {
    return { charging: '충전 중', discharging: '충전 안 함 · 방전 중', full: '충전 완료', idle: '충전 전류 없음' }[battery.chargingState] || '충전 상태 미확인';
  }
  if (battery?.chargingSource === 'io_state_monitor' && battery.ioCharging?.status === 'observed') {
    return battery.chargingState === 'conflict' ? '충전 정보 불일치' : battery.ioCharging.charging ? '충전 신호 감지 (IO)' : '충전 신호 없음 (IO)';
  }
  return ['observed', 'invalid'].includes(battery?.status) ? batteryPowerLabels[battery.powerSupplyStatus] || '충전 상태 미확인' : '충전 상태 미확인';
}
function batteryChargeSource(battery) {
  return { battery_current: '배터리 전류 · SLEC 양수=충전', battery_state: 'BMS power_supply_status', io_state_monitor: 'IO 충전 신호 · 전류 판정 미확인' }[battery?.chargingSource] || '미확인';
}
function batteryKnown(battery) { return battery?.status === 'observed' && Number.isFinite(battery.percent) && battery.percent >= 0 && battery.percent <= 100; }
function batteryLabel(battery) { return batteryKnown(battery) ? `${battery.percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%` : '미확인'; }
function batteryChargeBadge(battery, robotId = null) {
  const full = battery?.charging === false && (battery.chargingState === 'full' || (battery.chargingSource !== 'battery_current' && battery.powerSupplyStatus === 4));
  const kind = battery?.charging === true ? 'charging' : full ? 'full' : battery?.charging === false ? 'not-charging' : 'unknown';
  const label = { charging: '충전 중', 'not-charging': '충전 안 함', full: '충전 완료', unknown: '충전 미확인' }[kind];
  const paths = { charging: '<path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z"/>',
    'not-charging': '<path d="M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5M3 3l18 18"/>',
    full: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1"/>' };
  const content = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg><b>${label}</b>`;
  return robotId ? `<button type="button" class="battery-charge ${kind} charge-control-trigger" data-charge="${escapeHTML(robotId)}" title="충전 ON/OFF 제어 열기 · ${escapeHTML(batteryChargeLabel(battery))}" aria-label="${escapeHTML(robotId)} ${label} · 충전 ON/OFF 제어 열기">${content}<span class="charge-trigger-hint">제어 ↗</span></button>`
    : `<span class="battery-charge ${kind}" title="${escapeHTML(batteryChargeLabel(battery))}">${content}</span>`;
}
function batteryBadge(battery, robotId = null) {
  const charge = batteryChargeBadge(battery, robotId);
  const current = battery?.chargingSource === 'battery_current' && Number.isFinite(battery.current)
    ? `<small class="battery-charge-note">${battery.current > 0 ? '+' : ''}${battery.current.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} A${battery.chargingState === 'discharging' ? ' · 방전 중' : ''}</small>` : '';
  const liveLabel = battery?.live ? '실시간 수신' : { connecting: '실시간 연결 중', reconnecting: '다시 연결 중', paused: '갱신 정지', stale: '수신 지연', unavailable: '수신 미확인' }[battery?.liveStatus]
    || (batteryKnown(battery) ? '주기 조회' : '');
  const live = liveLabel ? `<small class="battery-live-status${battery?.live ? ' live' : ''}">${battery?.live ? '<i aria-hidden="true"></i>' : ''}${liveLabel}</small>` : '';
  if (!batteryKnown(battery)) return `<span class="battery-reading">${charge}<span class="battery-metrics"><span class="battery-unknown" title="${escapeHTML(batteryReasons[battery?.status] || batteryReasons.unavailable)}">잔량 미확인</span>${current}${live}</span></span>`;
  return `<span class="battery-reading${battery.percent <= 20 ? ' low' : ''}">${charge}<span class="battery-metrics"><span class="battery-level"><meter min="0" max="100" low="20" high="100" optimum="100" value="${battery.percent}" aria-label="배터리 잔량 ${batteryLabel(battery)}"></meter><strong>${batteryLabel(battery)}</strong></span>${current}${live}</span></span>`;
}
let toastTimer, refreshTimer, lastFocused, eventSource, batteryAgeTimer;
const batteryReceipts = new Map();
state.follow = true;

function rememberLiveBatteries() {
  for (const robot of state.snapshot?.robots || []) {
    const key = `${robot.id}:${robot.ip}`, battery = robot.battery, previous = batteryReceipts.get(key);
    if (!battery?.live) batteryReceipts.delete(key);
    else if (!previous || previous.observedAt !== battery.observedAt) batteryReceipts.set(key, { observedAt: battery.observedAt, at: Date.now() });
  }
}

function patchBatteryReading(reading, next) {
    const trigger = reading.querySelector('[data-charge]');
    const nextTrigger = next.querySelector('[data-charge]'), metrics = reading.querySelector('.battery-metrics');
    if (trigger && nextTrigger && metrics) {
      // Preserve the focused/clicked button while live battery values arrive.
      reading.className = next.className;
      for (const attribute of ['class', 'title', 'aria-label']) if (trigger.getAttribute(attribute) !== nextTrigger.getAttribute(attribute)) trigger.setAttribute(attribute, nextTrigger.getAttribute(attribute));
      if (trigger.innerHTML !== nextTrigger.innerHTML) trigger.innerHTML = nextTrigger.innerHTML;
      const content = next.querySelector('.battery-metrics').innerHTML;
      if (metrics.innerHTML !== content) metrics.innerHTML = content;
    } else reading.replaceWith(next);
}
function updateBatteryDisplay(robot) {
  const reading = document.querySelector(`[data-row="${robot.id}"] .battery-reading`);
  if (reading) {
    const template = document.createElement('template'); template.innerHTML = batteryBadge(robot.battery, robot.id);
    patchBatteryReading(reading, template.content.firstElementChild);
  }
  if (state.selected === robot.id && state.drawerMode !== 'io') renderDetail();
  else if (state.selected === robot.id && state.chargeControl) renderIoDetail(robot);
}
function receiveBattery(value) {
  if (!state.snapshot || !state.follow) return;
  const robot = state.snapshot.robots.find(item => item.id === value.id && item.ip === value.ip);
  if (!robot || !value.battery) return;
  robot.battery = value.battery;
  const key = `${robot.id}:${robot.ip}`;
  if (value.battery.live) batteryReceipts.set(key, { observedAt: value.battery.observedAt, at: Date.now() });
  else batteryReceipts.delete(key);
  updateBatteryDisplay(robot);
}
function expireLiveBatteries(now = Date.now()) {
  if (!state.snapshot || !state.follow) return;
  for (const robot of state.snapshot.robots) if (robot.battery?.live) {
    const battery = robot.battery;
    const receipt = batteryReceipts.get(`${robot.id}:${robot.ip}`);
    const age = receipt ? now - receipt.at + Math.max(0, battery.messageAgeSeconds || 0) * 1000 : Infinity;
    if (!Number.isFinite(age) || age > 2000) {
      robot.battery = { ...battery, status: 'stale', percent: null, current: null, charging: null, powerSupplyStatus: null,
        chargingState: 'unknown', chargingSource: null, live: false, liveStatus: 'stale', ioCharging: { status: 'stale' } };
      updateBatteryDisplay(robot);
    }
  }
}
function pauseLiveBatteries() {
  for (const robot of state.snapshot?.robots || []) if (robot.battery?.live) {
    robot.battery = { ...robot.battery, live: false, liveStatus: 'paused' }; updateBatteryDisplay(robot);
  }
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '서버 응답을 확인할 수 없습니다.');
  return data;
}
function observedRobots() { return state.snapshot.robots.filter(robot => robot.ssh === 'connected' && robot.observedAt && ['observed', 'partial'].includes(robot.quality)); }
function displayRid(robot) { return robot.observedRid || robot.plannedRid || (/^R_/.test(robot.id) ? robot.id : 'RID 미확인'); }
function rangeLabel(range) { return range ? `${range.startIp} – ${range.endIp}` : '192.168.20.51 – 192.168.20.100'; }

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}
function timeLabel(iso) { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function rosBadge(robot) { return `<span class="ros-badge ${robot.configuredRos}">${rosLabels[robot.configuredRos]}</span>`; }
function statusLabel(robot) { return robot.quality === 'pending' ? '조회 대기' : robot.quality === 'stale' ? '정보 오래됨' : robot.ssh === 'auth_failed' ? '인증 필요' : robot.ssh === 'host_key_unknown' ? '키 미등록' : robot.ssh === 'host_key_mismatch' ? '키 불일치' : robot.needsAttention ? '확인 필요' : robot.ssh === 'connected' ? '연결됨' : reachLabels[robot.reachability]; }
function dotClass(robot) { return robot.needsAttention ? 'warning' : robot.reachability === 'reachable' ? 'good' : robot.reachability === 'unreachable' ? 'offline' : 'neutral'; }
function filteredRobots() {
  const search = state.search.trim().toLowerCase();
  return observedRobots().filter(robot => {
    if (state.ros !== 'all' && robot.configuredRos !== state.ros) return false;
    if (state.model !== 'all' && robot.modelLabel !== state.model) return false;
    return !search || [robot.id, robot.ip, robot.modelLabel, robot.model, robot.distro, robot.observedRid].some(value => String(value || '').toLowerCase().includes(search));
  });
}
function robotPicture(robot, large = false) {
  const tower = /^(sr|stl|tt)/i.test(robot.model || '');
  return `<span class="robot-picture${tower ? ' blue' : ''}${large ? ' large' : ''}" aria-hidden="true"><svg viewBox="0 0 180 140"><use href="#robot-${tower ? 'tower' : 'platform'}"/></svg></span>`;
}
function servicePill(value) {
  const type = value === 'running' ? 'good' : ['failed', 'inactive', 'activating', 'deactivating'].includes(value) ? 'warning' : 'neutral';
  return `<span class="pill ${type}">${svg(value === 'running' ? 'check' : value === 'failed' ? 'info' : 'clock')}${serviceLabels[value] || '확인 안 됨'}</span>`;
}
function renderSummary() {
  const s = state.snapshot.summary;
  const seen = observedRobots(), ros1 = seen.filter(r => r.configuredRos === 'ros1').length, ros2 = seen.filter(r => r.configuredRos === 'ros2').length;
  const needsCheck = seen.filter(r => r.needsAttention).length;
  const pending = state.snapshot.collector.total - state.snapshot.collector.initialCompleted;
  const other = Math.max(0, s.total - s.sshConnected);
  $('summary').innerHTML = `
    <article class="summary-card mint"><span class="summary-icon">${svg('wifi')}</span><div class="summary-label">SSH 조회 성공</div><div class="summary-value">${seen.length}<small>대</small></div><div class="summary-foot">조회 대상 ${s.total}대 중 정보 확인</div></article>
    <article class="summary-card lavender"><span class="summary-icon">${svg('robot')}</span><div class="summary-label">ROS 구성</div><div class="ros-summary"><span>ROS1 <b>${ros1}</b></span><span>ROS2 <b>${ros2}</b></span></div><div class="summary-foot">연결된 로봇의 ROS 설정 기준</div></article>
    <article class="summary-card cream"><span class="summary-icon">${svg('clock')}</span><div class="summary-label">조회 미확인</div><div class="summary-value">${other}<small>대</small></div><div class="summary-foot">${pending ? `첫 확인 중 ${pending}대 · 응답 / 정보 미확인 포함` : '접속 / 정보 미확인 · 전원 상태 미판정'}</div></article>
    <article class="summary-card peach"><span class="summary-icon">${svg('info')}</span><div class="summary-label">확인 필요</div><div class="summary-value">${needsCheck}<small>대</small></div><div class="summary-foot">연결된 로봇의 설정 / 실행 확인 항목</div></article>`;
  $('hero-message').textContent = `등록 ${s.total}대 · 조회 성공 ${seen.length}대 · 확인 필요 ${needsCheck}대`;
  $('ops-interval').textContent = `${state.snapshot.collector.intervalMs / 1000} s`;
  $('pipeline-interval').textContent = `${state.snapshot.collector.intervalMs / 1000}초`;
}
function renderModels() {
  const options = [...new Set([...observedRobots().filter(robot => robot.model).map(robot => robot.modelLabel), ...(state.model !== 'all' ? [state.model] : [])])].sort();
  if ($('model-filter').dataset.options === JSON.stringify(options)) { $('model-filter').value = state.model; return; }
  $('model-filter').dataset.options = JSON.stringify(options);
  $('model-filter').innerHTML = '<option value="all">모델 전체</option>' + options.map(model => `<option>${escapeHTML(model)}</option>`).join('');
  $('model-filter').value = state.model;
}
function renderFleet() {
  if (!state.snapshot) return;
  if (state.fleetInteraction) { state.fleetRenderPending = true; return; }
  const now = Date.now(), registered = new Set(state.snapshot.robots.map(robot => `${robot.id}:${robot.ip}`));
  clearTimeout(rowRefresh.timer); rowRefresh.timer = null;
  for (const [key, until] of rowRefresh.until) if (until <= now || !registered.has(key)) rowRefresh.until.delete(key);
  const focused = document.activeElement;
  const focusedSelector = focused?.dataset?.bringup ? `[data-bringup="${focused.dataset.bringup}"]` : focused?.dataset?.charge ? `[data-charge="${focused.dataset.charge}"]` : focused?.dataset?.io ? `[data-io="${focused.dataset.io}"]`
    : focused?.dataset?.robot ? `[data-robot="${focused.dataset.robot}"].${focused.classList.contains('robot-identity') ? 'robot-identity' : 'table-detail'}` : null;
  const robots = filteredRobots();
  $('visible-count').textContent = robots.length;
  $('reset-filters').hidden = state.ros === 'all' && state.model === 'all' && !state.search;
  $('table-container').hidden = !robots.length;
  $('empty-state').hidden = robots.length !== 0;
  const rows = robots.map(robot => {
    const arrived = state.initialized && state.lastObserved.get(robot.id) !== robot.observedAt;
    const refreshKey = `${robot.id}:${robot.ip}`;
    if (arrived) rowRefresh.until.set(refreshKey, now + ROW_REFRESH_MS);
    const highlighted = (rowRefresh.until.get(refreshKey) || 0) > now;
    const bringup = typeof bringupButtons === 'function' ? bringupButtons(robot) : `<span class="pill ${robot.bringup === 'running' ? 'good' : 'neutral'}">${robot.bringup === 'running' ? '실행 중' : '실행 확인 안 됨'}</span>`;
    return `<tr class="robot-row${highlighted ? ' just-updated' : ''}" data-row="${robot.id}"><td><button class="robot-identity" data-robot="${robot.id}" aria-label="${escapeHTML(displayRid(robot))} 상세 보기">${robotPicture(robot)}<span><strong>${escapeHTML(displayRid(robot))}</strong><code>${robot.ip}:${robot.port}</code><span class="row-update-label" aria-hidden="true">${svg('refresh')}조회 갱신 완료</span></span></button></td><td><span class="pill ${robot.needsAttention ? 'warning' : 'good'}"><i class="dot ${dotClass(robot)}"></i>${statusLabel(robot)}</span></td><td><span class="model-name">${escapeHTML(robot.modelLabel)}</span></td><td>${rosBadge(robot)}<span class="distro-name">${escapeHTML(robot.distro || '배포판 미확인')}</span></td><td><span class="runtime-label ${robot.activeRos === 'ros1' || robot.activeRos === 'ros2' ? 'running' : ''}">${svg(robot.activeRos === 'ros1' || robot.activeRos === 'ros2' ? 'check' : 'info')}${robot.activeRos === 'stopped' ? '실행 안 됨' : robot.activeRos === 'unknown' ? '확인 안 됨' : `${rosLabels[robot.activeRos]} 실행`}</span></td><td>${servicePill(robot.service)}</td><td>${bringup}</td><td>${batteryBadge(robot.battery, robot.id)}</td><td><div class="row-actions">${ioButton(robot)}<button class="table-detail" data-robot="${robot.id}" aria-label="${escapeHTML(displayRid(robot))} 자세히 보기">자세히 ${svg('arrow')}</button></div></td></tr>`;
  }).join('');
  const table = $('robot-table');
  if (!table.rows) table.innerHTML = rows;
  else {
    const next = document.createElement('tbody'); next.innerHTML = rows;
    const current = new Map([...table.rows].map(row => [row.dataset.row, row]));
    const retained = new Set();
    for (const [index, candidate] of [...next.rows].entries()) {
      let row = current.get(candidate.dataset.row);
      if (row) {
        row.className = candidate.className;
        for (let cell = 0; cell < candidate.cells.length; cell++) {
          const oldReading = cell === 7 ? row.cells[cell].querySelector('.battery-reading') : null;
          const newReading = cell === 7 ? candidate.cells[cell].querySelector('.battery-reading') : null;
          if (oldReading && newReading) patchBatteryReading(oldReading, newReading);
          else if (row.cells[cell].innerHTML !== candidate.cells[cell].innerHTML) row.cells[cell].innerHTML = candidate.cells[cell].innerHTML;
        }
      } else row = candidate;
      retained.add(row.dataset.row);
      if (table.rows[index] !== row) table.insertBefore(row, table.rows[index] || null);
    }
    for (const row of [...table.rows]) if (!retained.has(row.dataset.row)) row.remove();
  }
  if (focusedSelector && !focused.isConnected) $('robot-table').querySelector(focusedSelector)?.focus({ preventScroll: true });
  for (const robot of state.snapshot.robots) state.lastObserved.set(robot.id, robot.observedAt);
  state.initialized = true;
  if (rowRefresh.until.size) rowRefresh.timer = setTimeout(renderFleet, Math.max(1, Math.min(...rowRefresh.until.values()) - Date.now()) + 16);
  $('updated-at').textContent = `최근 수집 ${timeLabel(state.snapshot.generatedAt)}`;
}
function renderHistory() {
  const events = state.snapshot.robots.flatMap(robot => (robot.history || []).map(event => ({ ...event, robot })))
    .sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 100);
  $('history-list').innerHTML = events.length ? events.map(event => `<article class="history-row"><time>${timeLabel(event.time)}</time><strong>${event.robot.id}</strong><span class="pill ${event.robot.needsAttention ? 'warning' : 'neutral'}">${escapeHTML(event.title)}</span><p>${escapeHTML(event.detail)}</p><button class="table-detail" data-robot="${event.robot.id}">상세 ↗</button></article>`).join('') : '<div class="loading-block">아직 상태 변화 이력이 없습니다.</div>';
}
function renderAll() {
  rememberLiveBatteries();
  renderSummary(); renderModels(); renderFleet(); renderHistory();
  const count = observedRobots().length;
  $('nav-count').textContent = count;
  const headingCount = document.querySelector('.heading-count'); if (headingCount) headingCount.textContent = count;
  const label = rangeLabel(state.snapshot.range);
  document.querySelector('.subnet').textContent = label; $('sidebar-range').textContent = label;
  if ($('applied-range')) $('applied-range').textContent = label;
  if (state.selected && !state.snapshot.robots.some(robot => robot.id === state.selected)) closeDetail();
  const c = state.snapshot.collector;
  $('collector-progress').textContent = `첫 조회 ${c.initialCompleted} / ${c.total} · 수집 ${c.active} · 대기 ${c.queued}`;
  document.querySelector('.collector-note').textContent = `기본 현황 ${c.intervalMs / 1000}초${state.snapshot.batteryLive?.active ? ' · 배터리 실시간' : ''}`;
  $('server-status').textContent = c.connected ? '수집 서버 연결됨' : '수집 서버 연결 확인 필요';
  $('server-dot').className = c.connected ? 'dot good' : 'dot warning';
  if (state.selected) renderDetail();
}
function resetFilters() { state.ros = 'all'; state.model = 'all'; state.search = ''; $('search').value = ''; $('ros-filter').value = 'all'; $('model-filter').value = 'all'; renderFleet(); }
function setPage(page) {
  state.page = page;
  const labels = { overview: ['로봇 현황', 'SSH 연결, ROS 런타임, 배터리 및 IO 상태를 모니터링합니다.'], history: ['변경 이력', '변화가 있었던 로봇과 확인할 항목을 모아봅니다.'], settings: ['수집 설정', '조회할 IP 범위를 설정하세요. 저장하면 바로 적용됩니다.'] };
  $('page-title').textContent = labels[page][0]; $('page-description').textContent = labels[page][1]; $('breadcrumb-current').textContent = labels[page][0];
  if (page === 'overview') $('page-title').insertAdjacentHTML('beforeend', `<span class="heading-count">${state.snapshot ? observedRobots().length : 0}</span>`);
  for (const key of ['overview', 'history', 'settings']) $(`${key}-page`).hidden = key !== page;
  document.querySelectorAll('[data-page]').forEach(button => { button.classList.toggle('active', button.dataset.page === page); if (button.dataset.page === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
}
function detailRows(rows) { return rows.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHTML(value)}</dd>`).join(''); }
function renderDetail() {
  const robot = state.snapshot.robots.find(item => item.id === state.selected);
  if (!robot) return;
  if (state.drawerMode === 'bringup') return renderBringupDetail(robot);
  if (state.drawerMode === 'io') return renderIoDetail(robot);
  $('drawer-title').textContent = displayRid(robot);
  $('drawer-check-time').textContent = robot.checkedAt ? `최근 조회 ${timeLabel(robot.checkedAt)}` : '아직 조회 전';
  const d = robot.details || {}, raw = d.scorpion || {}, battery = robot.battery;
  const mismatch = robot.observedRid && robot.plannedRid && robot.observedRid !== robot.plannedRid;
  $('drawer-content').innerHTML = `
    <div class="detail-top"><code>${robot.ip}:${robot.port}</code><span class="pill ${robot.needsAttention ? 'warning' : robot.reachability === 'reachable' ? 'good' : 'neutral'}"><i class="dot ${dotClass(robot)}"></i>${statusLabel(robot)}</span></div>
    <div class="detail-visual">${robotPicture(robot, true)}<div><div class="detail-title">${escapeHTML(robot.modelLabel)}</div><span class="detail-visual-caption">${rosLabels[robot.configuredRos]} · ${escapeHTML(robot.distro || '배포판 미확인')}</span></div></div><p class="detail-subtitle">${escapeHTML(robot.evidence)}</p>
    ${robot.issues.length ? `<div class="issue-list">${robot.issues.map(issue => `<p>${escapeHTML(issue)}</p>`).join('')}</div>` : ''}
    <div class="detail-actions">${ioButton(robot, true)}</div>
    <section class="detail-section"><h3>배터리 ${batteryBadge(battery, robot.id)}</h3><dl>${detailRows([['잔량', batteryLabel(battery)], ['충전 상태', batteryChargeLabel(battery)], ['판정 근거', batteryChargeSource(battery)], ['BMS 상태값', batteryPowerLabels[battery?.powerSupplyStatus] || '미확인'], ['IO 충전 신호', battery?.ioCharging?.status === 'observed' ? battery.ioCharging.charging ? 'ON' : 'OFF' : '미확인'], ['신호 비교', battery?.chargingConflict ? '전류 / BMS / IO 정보가 다름' : '확인된 정보 기준'], ['전압', battery?.voltage != null ? `${battery.voltage.toFixed(2)} V` : '미확인'], ['전류', battery?.current != null ? `${battery.current.toFixed(2)} A` : '미확인'], ['조회 결과', batteryKnown(battery) ? '실제 배터리 메시지 수신' : batteryReasons[battery?.status] || batteryReasons.unavailable], ['확인 시각', battery?.observedAt ? timeLabel(battery.observedAt) : '미확인'], ['배터리 토픽', battery?.topic || '미확인'], ['IO 충전 토픽', battery?.ioCharging?.topic || '미확인']])}</dl></section>
    <section class="detail-section"><h3>로봇 식별 <small>등록값 / 실제 관측</small></h3><dl>${detailRows([['계획 RID', robot.plannedRid || '매핑 없음'], ['관측 RID', robot.observedRid || '미확인'], ['RID 일치', mismatch ? '불일치 · 확인 필요' : robot.observedRid && robot.plannedRid ? '일치' : '해당 없음 / 미확인'], ['hostname', d.hostname || '미확인'], ['운영체제', d.os?.PRETTY_NAME || '미확인'], ['모델 원문', robot.model || '미확인'], ['모델 출처', robot.sources?.model?.[0]?.source || '미확인'], ['RID 출처', robot.sources?.rid || '미확인']])}</dl></section>
    <section class="detail-section"><h3>ROS 설정과 실행 ${rosBadge(robot)}</h3><dl>${detailRows([['설정 ROS', rosLabels[robot.configuredRos]], ['배포판', robot.distro || '미확인'], ['실행 ROS', rosLabels[robot.activeRos]], ['설치 목록', d.installedDistros?.join(', ') || '미확인'], ['판정 근거', robot.sources?.ros || '미확인'], ['ROS 프로세스', d.processCount === undefined ? '미확인' : `${d.processCount}개 · graph 정상 여부는 별도`]])}</dl></section>
    <section class="detail-section"><h3>서비스 상태 <small>ROS1 scorpion · ROS2 bringup</small></h3><dl>${detailRows([['scorpion', serviceLabels[robot.service]], ['LoadState', raw.load_state || '미확인'], ['Active / SubState', raw.active_state ? `${raw.active_state} / ${raw.sub_state}` : '미확인'], ['부팅 시 자동 시작', raw.unit_file_state || '미확인 / 해당 없음'], ['Main PID', raw.main_pid ?? '미확인'], ['bringup', robot.bringup === 'running' ? '실행 중' : robot.bringup === 'not_applicable' ? '해당 없음' : robot.bringup === 'stopped' ? '실행 미확인' : '미확인'], ['SSH 상태', robot.ssh === 'connected' ? '인증 / 조회 성공' : robot.ssh], ['호스트키 지문', d.fingerprint || '기존 known_hosts 검증'], ['최근 성공 확인', robot.observedAt ? timeLabel(robot.observedAt) : '미확인']])}</dl></section>
    ${robot.previous ? `<section class="detail-section"><h3>이전 확인값 <small>현재 상태와 구분</small></h3><dl>${detailRows([['이전 모델', robot.previous.model || '미확인'], ['이전 ROS 설정', rosLabels[robot.previous.configuredRos] || '미확인'], ['이전 배터리 잔량', batteryLabel(robot.previous.battery)], ['이전 확인 시각', robot.previous.observedAt ? new Date(robot.previous.observedAt).toLocaleString('ko-KR') : '미확인']])}</dl></section>` : ''}
    <section class="detail-section"><h3>상태 변화 이력</h3><div class="detail-timeline">${robot.history.length ? robot.history.map(event => `<div class="detail-timeline-item"><strong>${escapeHTML(event.title)}</strong><time>${timeLabel(event.time)}</time><p>${escapeHTML(event.detail)}</p></div>`).join('') : '<p class="muted">아직 이력이 없습니다.</p>'}</div></section>
    <div class="detail-note">실제 SSH 읽기 조회 결과입니다. 미확인은 정지나 전원 OFF를 뜻하지 않으며, 프로세스 확인은 실제 주행 가능 판정과 다릅니다.</div>`;
}
function openDetail(id, mode = 'detail') {
  if (!state.snapshot.robots.some(robot => robot.id === id)) return;
  stopIo();
  stopBringupPanel();
  if (state.selected !== id) lastFocused = document.activeElement;
  state.chargeControl = mode === 'charge';
  if (state.chargeControl) mode = 'io';
  state.selected = id; state.drawerMode = mode;
  $('detail-drawer').classList.toggle('io-mode', mode === 'io' || mode === 'bringup');
  $('drawer-mode-label').textContent = mode === 'bringup' ? 'BRINGUP CONTROL · 켜기 / 끄기' : state.chargeControl ? 'CHARGE CONTROL · 충전 ON/OFF' : mode === 'io' ? 'IO CHECK · 상태 조회 / DO 제어' : 'ROBOT DETAILS · 상태 조회';
  $('drawer-refresh').innerHTML = `${svg('refresh')}${mode === 'io' ? 'IO 다시 연결' : '이 로봇 다시 조회'}`;
  $('drawer-refresh').disabled = false;
  renderDetail(); renderFleet();
  $('drawer-backdrop').hidden = false; $('detail-drawer').hidden = false;
  $('close-drawer').focus();
  if (mode === 'io') startIo();
  if (mode === 'bringup') startBringupPanel();
}
function closeDetail() {
  stopBringupPanel();
  stopIo(); state.drawerMode = 'detail'; state.chargeControl = false; $('detail-drawer').classList.remove('io-mode');
  state.selected = null; $('drawer-backdrop').hidden = true; $('detail-drawer').hidden = true;
  renderFleet();
  const id = lastFocused?.dataset?.bringup || lastFocused?.dataset?.charge || lastFocused?.dataset?.robot || lastFocused?.dataset?.io;
  const attribute = lastFocused?.dataset?.bringup ? 'data-bringup' : lastFocused?.dataset?.charge ? 'data-charge' : lastFocused?.dataset?.io ? 'data-io' : 'data-robot';
  const card = id ? [...document.querySelectorAll(`[${attribute}="${id}"]`)].find(el => el.getClientRects().length) : lastFocused;
  card?.focus();
}
async function refreshLive(id = null) {
  if (state.refreshing) return;
  state.refreshing = true; $('refresh-button').disabled = true; $('refresh-button').classList.add('is-refreshing'); $('drawer-refresh').disabled = true;
  try {
    await api(id ? `/api/robots/${id}/refresh` : '/api/fleet/refresh', 'POST');
    state.snapshot = await api('/api/fleet'); renderAll();
    toast(id ? `${id} 읽기 조회를 예약했습니다.` : '전체 읽기 조회를 예약했습니다. 결과가 도착하면 반영합니다.');
  } catch (error) { toast(error.message); }
  finally { state.refreshing = false; $('refresh-button').disabled = false; $('refresh-button').classList.remove('is-refreshing'); $('drawer-refresh').disabled = false; }
}
function connectUpdates() {
  eventSource?.close(); eventSource = null; clearInterval(refreshTimer);
  if (!state.follow || document.hidden) return;
  if (!batteryAgeTimer) batteryAgeTimer = setInterval(expireLiveBatteries, 500);
  if (typeof EventSource === 'undefined') {
    refreshTimer = setInterval(async () => { if (!state.follow) return; try { state.snapshot = await api('/api/fleet'); renderAll(); } catch { $('server-status').textContent = '서버 응답 확인 필요'; } }, 5000);
    return;
  }
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('fleet', event => {
    try { const snapshot = JSON.parse(event.data);
      if (snapshot.mode !== 'live' || snapshot.sequence < (state.snapshot?.sequence || 0) || !state.follow) return;
      state.snapshot = snapshot; renderAll();
    } catch { $('server-status').textContent = '상태 갱신 확인 필요'; }
  });
  eventSource.addEventListener('battery', event => {
    try { receiveBattery(JSON.parse(event.data)); } catch { $('server-status').textContent = '배터리 수신 재확인 중'; }
  });
  eventSource.onerror = () => { $('server-status').textContent = '실시간 연결 재확인 중'; $('server-dot').className = 'dot warning'; };
}
function renderSettings(settings) {
  state.settings = settings;
  $('settings-content').innerHTML = `<article class="range-settings"><h3>조회할 IP 범위</h3>
    <form id="range-form"><label for="range-start">시작 IP</label><input id="range-start" name="startIp" required inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="15" value="${escapeHTML(settings.range.startIp)}">
    <label for="range-end">끝 IP</label><input id="range-end" name="endIp" required inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="15" value="${escapeHTML(settings.range.endIp)}">
    <p class="range-help">사설 IPv4 · 시작/끝 포함 최대 ${settings.maxTargets}개<br>기본값: 192.168.20.51 – 192.168.20.100</p>
    <div class="range-actions"><button id="range-save" class="button primary" type="submit">저장 후 조회</button><button id="range-default" class="button secondary" type="button">기본값 입력</button></div>
    <p id="range-feedback" role="status" aria-live="polite"></p></form>
    <p class="range-current">적용 범위 <strong id="applied-range">${escapeHTML(rangeLabel(settings.range))}</strong></p></article>
    <article><h3>실제 수집</h3><dl>${detailRows([['수집 방식', 'SSH 읽기 전용'], ['목록 표시', '현재 정보 조회 성공 로봇'], ['수집 목표 간격', settings.intervalMs / 1000 + '초'], ['동시 조회 제한', settings.concurrency + '대'], ['수동 제어', 'IO 체크의 DO ON/OFF']])}</dl></article>
    <article><h3>서버 인증 설정</h3><dl>${detailRows([['접속 계정', settings.username], ['SSH 키', settings.keyConfigured ? '설정됨' : '미설정'], ['비밀번호', settings.passwordConfigured ? '설정됨 · 값 비공개' : '미설정'], ['known_hosts', settings.knownHostsConfigured ? '설정됨 · 키 검증 적용' : '등록 필요'], ['DO 제어', settings.doControl?.enabled ? settings.doControl.pinRequired ? 'PIN 인증 후 사용' : '바로 사용 · PIN 비활성' : '비활성화 · 조회 전용'], ['DO PIN', settings.doControl?.pinConfigured ? '설정됨 · 값 비공개' : '서버 관리자 설정 필요']])}</dl></article>`;
  $('range-form').onsubmit = saveRange;
  $('range-default').onclick = () => {
    $('range-start').value = settings.defaultRange.startIp; $('range-end').value = settings.defaultRange.endIp;
    $('range-feedback').textContent = '기본값을 입력했습니다. 저장 후 조회를 누르면 적용됩니다.';
  };
}
async function saveRange(event) {
  event.preventDefault(); const save = $('range-save'); if (save.disabled) return;
  save.disabled = true; $('range-default').disabled = true; $('range-feedback').textContent = 'IP 범위를 저장하는 중입니다…';
  try {
    const result = await api('/api/settings/range', 'POST', { startIp: $('range-start').value.trim(), endIp: $('range-end').value.trim() });
    state.snapshot = result.snapshot; resetFilters(); renderAll();
    $('range-feedback').textContent = `${result.range.total}개 IP를 조회합니다. 범위는 서버 재시작 후에도 유지됩니다.`;
    toast('IP 범위를 저장하고 읽기 조회를 시작했습니다.');
  } catch (error) { $('range-feedback').textContent = error.message; }
  finally { save.disabled = false; $('range-default').disabled = false; }
}
function exportCSV() {
  if (!state.snapshot) return;
  const rows = [['데이터 구분', 'RID', 'IP', 'SSH 포트', '연결 상태', '모델', '설정 ROS', '실행 ROS', '배포판', 'scorpion', 'bringup', '배터리 잔량 (%)', '충전 상태', '배터리 전압 (V)', '배터리 확인 시각', '충전 판정 근거'], ...filteredRobots().map(r => [r.quality === 'observed' || r.quality === 'partial' ? '실제 조회' : '미확인', displayRid(r), r.ip, r.port, statusLabel(r), r.modelLabel, rosLabels[r.configuredRos], rosLabels[r.activeRos], r.distro || '미확인', serviceLabels[r.service], r.bringup, batteryKnown(r.battery) ? r.battery.percent : '', batteryChargeLabel(r.battery), r.battery?.voltage ?? '', r.battery?.observedAt || '', batteryChargeSource(r.battery)])];
  const csv = '\uFEFF' + rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'amr-fleet-status.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`현재 조회 목록 ${rows.length - 1}대를 CSV로 내보냈습니다.`);
}
async function init() {
  // A full fleet update must not remove a button between pointer-down and click.
  const releaseFleet = () => {
    const interaction = state.fleetInteraction;
    if (!interaction) return;
    setTimeout(() => {
      if (state.fleetInteraction !== interaction) return;
      state.fleetInteraction = null;
      if (state.fleetRenderPending) { state.fleetRenderPending = false; renderFleet(); }
    }, 0);
  };
  const holdFleet = event => {
    if (event.type === 'keydown' && ![' ', 'Enter'].includes(event.key)) return;
    if (event.target.closest('#robot-table [data-charge], #robot-table [data-io], #robot-table [data-robot], #robot-table [data-bringup]')) state.fleetInteraction = {};
  };
  document.addEventListener('pointerdown', holdFleet, true);
  document.addEventListener('keydown', holdFleet, true);
  for (const name of ['pointerup', 'pointercancel', 'keyup']) document.addEventListener(name, releaseFleet, true);
  window.addEventListener('blur', releaseFleet);
  document.addEventListener('click', event => {
    const charge = event.target.closest('[data-charge]'); if (charge && state.snapshot) { openDetail(charge.dataset.charge, 'charge'); return; }
    const io = event.target.closest('[data-io]'); if (io && state.snapshot) { openDetail(io.dataset.io, 'io'); return; }
    const card = event.target.closest('[data-robot]'); if (card && state.snapshot) openDetail(card.dataset.robot);
    const page = event.target.closest('[data-page]'); if (page) setPage(page.dataset.page);
  });
  $('search').addEventListener('input', event => { state.search = event.target.value; renderFleet(); });
  $('ros-filter').addEventListener('change', event => { state.ros = event.target.value; renderFleet(); });
  $('model-filter').addEventListener('change', event => { state.model = event.target.value; renderFleet(); });
  $('reset-filters').onclick = resetFilters; $('empty-reset').onclick = resetFilters;
  $('close-drawer').onclick = closeDetail; $('drawer-backdrop').onclick = closeDetail;
  $('refresh-button').onclick = () => refreshLive(); $('drawer-refresh').onclick = () => state.drawerMode === 'bringup' ? fetchBringupStatus() : state.drawerMode === 'io' ? fetchIo() : refreshLive(state.selected);
  $('export-button').onclick = exportCSV;
  $('auto-refresh').onchange = async event => {
    state.follow = event.target.checked;
    if (state.follow) { try { state.snapshot = await api('/api/fleet'); renderAll(); connectUpdates(); } catch { toast('서버 연결을 확인하세요.'); } }
    else { eventSource?.close(); eventSource = null; clearInterval(refreshTimer); pauseLiveBatteries(); toast('화면 갱신과 배터리 실시간 수신을 일시 정지했습니다.'); }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { eventSource?.close(); eventSource = null; clearInterval(refreshTimer); pauseLiveBatteries(); }
    else { expireLiveBatteries(); connectUpdates(); }
  });
  $('how-button').onclick = () => { $('how-panel').hidden = !$('how-panel').hidden; $('how-button').setAttribute('aria-expanded', String(!$('how-panel').hidden)); };
  $('help-button').onclick = () => { $('help-popover').hidden = !$('help-popover').hidden; $('help-button').setAttribute('aria-expanded', String(!$('help-popover').hidden)); };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (!$('detail-drawer').hidden) closeDetail(); $('help-popover').hidden = true; $('help-button').setAttribute('aria-expanded', 'false'); }
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && $('detail-drawer').hidden) { event.preventDefault(); setPage('overview'); $('search').focus(); }
    if (event.key === 'Tab' && !$('detail-drawer').hidden) {
      const focusable = [...$('detail-drawer').querySelectorAll('button,a,input,select,[tabindex="0"]')].filter(el => !el.disabled);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  try {
    const [snapshot, health, settings] = await Promise.all([api('/api/fleet'), api('/api/health'), api('/api/settings')]);
    if (snapshot.mode !== 'live' || health.mode !== 'live') throw new Error('실제 수집 모드를 확인할 수 없습니다.');
    renderSettings(settings);
    state.snapshot = snapshot; renderAll();
    $('server-status').textContent = '수집 서버 연결됨'; $('server-dot').className = 'dot good';
    connectUpdates();
    document.documentElement.dataset.ready = 'true';
  } catch (error) {
    $('summary').innerHTML = '<div class="loading-block">데이터를 불러오지 못했습니다. 서버 상태를 확인한 뒤 새로고침하세요.</div>';
    $('server-status').textContent = '서버 응답 확인 필요'; $('server-dot').className = 'dot warning'; toast(error.message);
  }
}
init();
