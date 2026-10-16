'use strict';
const ioState = { value: null, pending: false, ageTimer: null, stream: null, generation: 0, changed: new Set(), flashes: new Map(), layout: null, outputPending: null, outputResult: null,
  authPending: false, authorizedUntil: 0, authMessage: '' };
const ioDriverAvailability = new Map();
function ioDriverState(robot) {
  const live = ioDriverAvailability.get(robot.id);
  return live && live.at >= Date.parse(robot.observedAt || 0) ? live.status : robot.ioDriverStatus || 'unknown';
}
function ioButton(robot, detail = false) {
  const status = ioDriverState(robot), stopped = status === 'stopped';
  const title = status === 'running' ? 'io_driver_node 실행 확인' : stopped ? 'io_driver_node 미실행 · IO 체크 불가' : 'io_driver_node 실행 여부 미확인';
  return `<button class="${detail ? 'button secondary' : 'table-detail'} io-check-button ${status}" data-io="${robot.id}" title="${title}" aria-label="${escapeHTML(displayRid(robot))} IO 체크 · ${title}"${stopped ? ' disabled' : ''}><span class="io-button-dot" aria-hidden="true"></span>${stopped ? 'IO 미실행' : status === 'running' ? 'IO 체크' : 'IO 확인'}</button>`;
}
const ioReasons = { paused: '탭이 숨겨져 IO 연결을 일시 정지했습니다.', removed: '조회 범위에서 제외된 로봇입니다.', unsupported_browser: '브라우저에서 실시간 연결을 지원하지 않습니다.', loading: 'IO 상태를 읽고 있습니다…', node_not_found: 'io_driver_node 실행을 확인하지 못했습니다.',
  no_topic: 'io_driver_node의 io/status 토픽이 없습니다.', unsupported: '이 IO 체크는 ROS2 io_driver_node를 지원합니다.',
  identity_unknown: 'IO 토픽의 로봇 namespace를 확인할 수 없습니다.', ambiguous: 'IO 노드 또는 발행자가 여러 개입니다.',
  runtime_unavailable: '로봇의 ROS IO 메시지 읽기 환경을 확인할 수 없습니다.', timeout: 'IO 수신 시간이 초과되었습니다.',
  stale: 'IO 정보가 오래되어 현재 ON/OFF를 표시하지 않습니다.', invalid: 'IO 메시지 형식을 확인할 수 없습니다.',
  empty: 'IO 노드는 확인됐지만 채널 정보가 없습니다.', busy: '다른 IO 조회가 진행 중입니다. 잠시 후 다시 확인합니다.',
  auth_failed: 'SSH 인증에 실패했습니다.', host_key_unknown: 'SSH 호스트키가 등록되지 않았습니다.',
  host_key_mismatch: 'SSH 호스트키가 기존 등록값과 다릅니다.', unavailable: '현재 IO 상태를 확인할 수 없습니다.' };
const ioChannelKey = channel => `${channel.deviceName}:${channel.type}:${channel.channel}`;
function ioView(value, now = Date.now()) {
  if (!value) return { status: 'loading', diChannels: [], doChannels: [] };
  if (['observed', 'partial'].includes(value.status) && (!Number.isFinite(Date.parse(value.checkedAt))
    || now - Date.parse(value.checkedAt) + Math.max(0, value.messageAgeSeconds || 0) * 1000 > (value.live ? 2000 : 10000))) {
    return { ...value, status: 'stale', diChannels: [], doChannels: [] };
  }
  return value;
}
function ioChannelCards(channels) {
  return channels.map(channel => {
    const label = channel.isValid && channel.state === 'on' ? 'ON · 1' : channel.isValid && channel.state === 'off' ? 'OFF · 0' : '미확인';
    const kind = channel.isValid ? channel.state : 'unknown';
    const controls = channel.type === 'DO' ? `<span class="io-output-actions"><button type="button" data-io-output="1" disabled aria-label="${escapeHTML(channel.logicalName)} 논리 ON">ON</button><button type="button" data-io-output="0" disabled aria-label="${escapeHTML(channel.logicalName)} 논리 OFF">OFF</button></span>` : '';
    return `<article class="io-channel ${kind}" data-io-channel="${escapeHTML(ioChannelKey(channel))}"><span class="io-channel-id">${channel.type} ${String(channel.channel ?? '?').padStart(2, '0')}</span><strong>${escapeHTML(channel.logicalName || '이름 미등록')}</strong><span class="io-value ${kind}">${label}</span>${controls}</article>`;
  }).join('');
}
function ioDeviceBoards(io) {
  const devices = [...new Set([...io.diChannels, ...io.doChannels].map(ch => ch.deviceName))].sort();
  return devices.map(device => `<section class="io-device"><h3>${escapeHTML(device)}</h3><div class="io-board">${[['DI', 'DI 입력', io.diChannels], ['DO', 'DO 출력', io.doChannels]].map(([type, label, channels]) => {
    const selected = channels.filter(ch => ch.deviceName === device).sort((a, b) => (a.channel ?? Infinity) - (b.channel ?? Infinity));
    return `<section class="io-group" data-device="${escapeHTML(device)}" data-type="${type}"><h4>${label}<small class="io-group-count"></small></h4><div class="io-columns"><span>채널</span><span>신호 이름</span><span>원시값</span>${type === 'DO' ? '<span>논리 제어</span>' : ''}</div><div class="io-channels">${ioChannelCards(selected)}</div>${selected.length ? '' : '<p class="muted">등록된 채널이 없습니다.</p>'}</section>`;
  }).join('')}</div></section>`).join('');
}
function renderIoDetail(robot) {
  const io = ioView(ioState.value), known = ['observed', 'partial'].includes(io.status);
  $('drawer-title').textContent = `${displayRid(robot)} · IO 체크`;
  $('drawer-check-time').textContent = ioState.pending ? 'IO 연결 중…' : io.checkedAt ? `수신 ${timeLabel(io.checkedAt)}${io.live && io.intervalMs > 0 ? ` · ${Math.round(io.intervalMs)} ms 주기` : ''}` : '첫 IO 수신 대기';
  $('drawer-refresh').disabled = ioState.pending || Boolean(ioState.outputPending);
  const structure = JSON.stringify([known, known ? [...io.diChannels, ...io.doChannels].map(ch => [ch.deviceName, ch.type, ch.channel, ch.logicalName]) : io.status]);
  if (ioState.layout !== structure) {
    ioState.layout = structure;
    $('drawer-content').innerHTML = `<div class="io-intro"><div><code>${escapeHTML(robot.ip)}:${robot.port}</code><span class="pill io-stream-status"></span></div><p>입력과 출력의 현재 신호를 확인하세요.</p><small>연결을 유지해 IO 변화를 바로 전달합니다. 패널을 닫으면 연결을 마칩니다.</small></div>
      <div class="io-note">상태는 원시값이며 DO 버튼은 논리명 기준 ON/OFF입니다. 반전 설정에 따라 둘은 다를 수 있습니다. DO 제어는 모터 전원·충전 릴레이 등 연결 장치에 적용됩니다.</div>
      <section class="io-control-gate" aria-label="DO 제어 잠금">
        <div class="io-control-heading"><strong id="io-control-status"></strong><button id="io-control-lock" class="button secondary" type="button" hidden>제어 잠금</button></div>
        <p id="io-control-description"></p>
        <form id="io-pin-form" hidden autocomplete="off"><label for="io-pin">DO 제어 PIN</label><div><input id="io-pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autocomplete="off" spellcheck="false" placeholder="6~12자리 숫자"><button id="io-pin-submit" class="button primary" type="submit">잠금 해제</button></div></form>
        <p id="io-pin-feedback" role="status"></p>
      </section>
      <p class="io-output-feedback" role="status" hidden></p>
      ${known ? `<div class="io-overview"></div>${ioDeviceBoards(io)}<p class="io-notice io-invalid-notice" hidden>유효하지 않은 채널은 미확인으로 표시합니다.</p>` : `<p class="io-notice" role="status">${escapeHTML(ioReasons[io.status] || ioReasons.unavailable)}</p>`}
      <dl class="io-source">${detailRows([['노드', io.node || '미확인'], ['토픽', io.topic || '미확인']])}</dl>`;
    $('io-pin-form').onsubmit = unlockIoControl;
    $('io-control-lock').onclick = lockIoControl;
  }
  const enabled = io.controlEnabled ?? state.settings?.doControl?.enabled ?? false;
  const unlocked = Boolean(io.controlAuthorized && ioState.authorizedUntil > Date.now());
  $('io-control-status').textContent = !enabled ? 'DO 제어 비활성화 · 조회 전용' : unlocked ? 'DO 제어 활성 · PIN 인증 완료' : 'DO 제어 잠김';
  $('io-control-description').textContent = !enabled ? '서버 관리자가 .env에서 PIN을 설정하고 DO 제어를 활성화해야 합니다.'
    : unlocked ? '인증은 이 IO 화면에서 최대 5분간 유효합니다. 패널을 닫거나 재연결하면 잠깁니다.' : '관리자가 정한 PIN으로 이 화면의 출력 제어를 잠금 해제하세요. IO 조회는 계속 사용할 수 있습니다.';
  $('io-pin-form').hidden = !enabled || unlocked;
  $('io-control-lock').hidden = !unlocked;
  $('io-control-lock').disabled = Boolean(ioState.outputPending);
  $('io-pin-submit').disabled = ioState.authPending || !io.controlToken;
  $('io-pin').disabled = ioState.authPending || !io.controlToken;
  $('io-pin-feedback').textContent = ioState.authMessage;
  const badge = $('drawer-content').querySelector('.io-stream-status');
  badge.textContent = known ? '실시간 수신 중' : io.status === 'loading' ? '연결 중' : 'IO 미확인';
  badge.className = `pill io-stream-status ${known && io.status !== 'partial' ? 'good' : 'neutral'}`;
  const feedback = $('drawer-content').querySelector('.io-output-feedback');
  feedback.hidden = !ioState.outputPending && !ioState.outputResult;
  feedback.className = `io-output-feedback ${ioState.outputResult?.status || 'pending'}`;
  feedback.textContent = ioState.outputPending ? `${ioState.outputPending.logicalName} · 논리 ${ioState.outputPending.value ? 'ON' : 'OFF'} 요청 중…` : ioState.outputResult?.text || '';
  if (!known) return;
  const channels = [...io.diChannels, ...io.doChannels], byKey = new Map(channels.map(ch => [ioChannelKey(ch), ch]));
  for (const row of $('drawer-content').querySelectorAll('.io-channel')) {
    const channel = byKey.get(row.dataset.ioChannel), kind = channel.isValid ? channel.state : 'unknown';
    const rowClass = `io-channel ${kind}${(ioState.flashes.get(ioChannelKey(channel)) || 0) > Date.now() ? ' changed' : ''}`;
    if (row.className !== rowClass) row.className = rowClass;
    const value = row.querySelector('.io-value'), valueClass = `io-value ${kind}`;
    if (value.className !== valueClass) value.className = valueClass;
    const text = kind === 'on' ? 'ON · 1' : kind === 'off' ? 'OFF · 0' : '미확인';
    if (value.textContent !== text) value.textContent = text;
    for (const button of row.querySelectorAll('[data-io-output]')) {
      const unique = channels.filter(ch => ch.logicalName === channel.logicalName).length === 1;
      button.disabled = !unlocked || !io.controlToken || !channel.isValid || !channel.logicalName || !unique || Boolean(ioState.outputPending);
      button.title = !unlocked ? 'DO 제어 PIN 인증이 필요합니다.' : button.disabled ? '실시간으로 확인된 DO 채널에서만 제어할 수 있습니다.' : `${channel.logicalName} 논리 ${button.dataset.ioOutput === '1' ? 'ON' : 'OFF'} 요청`;
    }
  }
  for (const group of $('drawer-content').querySelectorAll('.io-group')) {
    const selected = channels.filter(ch => ch.deviceName === group.dataset.device && ch.type === group.dataset.type);
    const count = group.querySelector('.io-group-count');
    const text = `${selected.length}개 · ON ${selected.filter(ch => ch.isValid && ch.state === 'on').length} · 미확인 ${selected.filter(ch => !ch.isValid).length}`;
    if (count.textContent !== text) count.textContent = text;
  }
  const overview = $('drawer-content').querySelector('.io-overview');
  const summary = `<span>DI 입력 <b>${io.diChannels.length}</b></span><span>DO 출력 <b>${io.doChannels.length}</b></span><span>ON <b>${channels.filter(ch => ch.isValid && ch.state === 'on').length}</b></span><span>미확인 <b>${io.invalidCount || 0}</b></span>`;
  if (overview.innerHTML !== summary) overview.innerHTML = summary;
  $('drawer-content').querySelector('.io-invalid-notice').hidden = io.status !== 'partial';
}
function stopIo() {
  ioState.generation++; clearInterval(ioState.ageTimer); ioState.stream?.close();
  ioState.value = null; ioState.pending = false; ioState.stream = null; ioState.layout = null; ioState.changed.clear(); ioState.flashes.clear();
  ioState.outputPending = null; ioState.outputResult = null;
  ioState.authPending = false; ioState.authorizedUntil = 0; ioState.authMessage = '';
}
function startIo() {
  ioState.ageTimer = setInterval(() => {
    if (ioState.authorizedUntil && ioState.authorizedUntil <= Date.now()) {
      ioState.authorizedUntil = 0;
      if (ioState.value) ioState.value.controlAuthorized = false;
      ioState.authMessage = 'PIN 인증이 만료되었습니다. 다시 입력하세요.';
      if (state.drawerMode === 'io') renderDetail();
    }
    if (state.drawerMode === 'io' && state.selected && ioView(ioState.value).status === 'stale') renderDetail();
  }, 250);
  fetchIo();
}
function fetchIo() {
  if (state.drawerMode !== 'io' || !state.selected || document.hidden) return;
  ioState.stream?.close();
  const id = state.selected, generation = ++ioState.generation;
  ioState.authorizedUntil = 0; ioState.authPending = false; ioState.authMessage = '';
  ioState.value = null; ioState.layout = null; ioState.pending = true; renderDetail();
  if (typeof EventSource === 'undefined') {
    ioState.pending = false; ioState.value = { status: 'unsupported_browser', diChannels: [], doChannels: [] }; renderDetail(); return;
  }
  const stream = new EventSource(`/api/robots/${encodeURIComponent(id)}/io/events`); ioState.stream = stream;
  stream.addEventListener('io', event => {
    if (generation !== ioState.generation || state.selected !== id) return;
    try {
      const value = JSON.parse(event.data);
      if (value.id !== id || !Array.isArray(value.diChannels) || !Array.isArray(value.doChannels)) throw new Error('IO schema');
      const previous = new Map([...(ioState.value?.diChannels || []), ...(ioState.value?.doChannels || [])].map(ch => [ioChannelKey(ch), ch]));
      for (const ch of [...value.diChannels, ...value.doChannels]) {
        const old = previous.get(ioChannelKey(ch));
        if (ch.isValid && old?.isValid && old.value !== ch.value) ioState.flashes.set(ioChannelKey(ch), Date.now() + 700);
      }
      ioState.value = value; ioState.pending = value.status === 'loading';
      const availability = ['observed', 'partial', 'empty'].includes(value.status) ? 'running' : value.status === 'node_not_found' && value.driverRunning === false ? 'stopped' : null;
      if (availability) {
        const changed = ioDriverAvailability.get(id)?.status !== availability;
        ioDriverAvailability.set(id, { status: availability, at: Date.now() });
        if (changed) renderFleet();
      }
      renderDetail();
      if (['unsupported', 'runtime_unavailable', 'credentials_invalid', 'auth_failed', 'host_key_unknown', 'host_key_mismatch', 'removed'].includes(value.status)) stream.close();
    } catch {
      ioState.pending = false; ioState.value = { status: 'unavailable', diChannels: [], doChannels: [] }; renderDetail();
    }
  });
  stream.onerror = () => {
    if (generation !== ioState.generation || state.selected !== id) return;
    ioState.pending = false; ioState.value = { status: 'unavailable', diChannels: [], doChannels: [] }; renderDetail();
  };
}
document.addEventListener('visibilitychange', () => {
  if (state.drawerMode !== 'io') return;
  if (!document.hidden) fetchIo();
  else {
    ioState.generation++; ioState.stream?.close(); ioState.stream = null; ioState.pending = false;
    ioState.authorizedUntil = 0;
    ioState.value = { status: 'paused', diChannels: [], doChannels: [] }; renderDetail();
  }
});

async function unlockIoControl(event) {
  event.preventDefault();
  if (ioState.authPending || !ioState.value?.controlToken) return;
  const input = $('io-pin'), id = state.selected, generation = ioState.generation, token = ioState.value.controlToken;
  // Keep the entered PIN out of state, DOM attributes and browser storage.
  const body = JSON.stringify({ pin: input.value }); input.value = '';
  ioState.authPending = true; ioState.authMessage = 'PIN 확인 중…'; renderDetail();
  try {
    const response = await fetch(`/api/robots/${encodeURIComponent(id)}/io/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IO-Control-Token': token }, body, signal: AbortSignal.timeout(8000)
    });
    const result = await response.json();
    if (generation !== ioState.generation || state.selected !== id) return;
    if (response.ok && result.authorized && ioState.value?.controlToken === token) {
      ioState.authorizedUntil = Date.now() + result.expiresInMs; ioState.value.controlAuthorized = true;
      ioState.authMessage = '';
    } else ioState.authMessage = result.error || 'PIN 인증을 완료하지 못했습니다.';
  } catch {
    if (generation === ioState.generation) ioState.authMessage = 'PIN 인증 응답을 확인하지 못했습니다. 다시 시도하세요.';
  } finally {
    if (generation === ioState.generation && state.selected === id) { ioState.authPending = false; renderDetail(); }
  }
}
async function lockIoControl() {
  const id = state.selected, token = ioState.value?.controlToken;
  // Close the authorized stream even if the lock request cannot reach the server.
  if (token) fetch(`/api/robots/${encodeURIComponent(id)}/io/lock`, {
    method: 'POST', headers: { 'X-IO-Control-Token': token }, signal: AbortSignal.timeout(3000)
  }).catch(() => {});
  fetchIo();
}

async function setIoOutput(key, value) {
  const io = ioView(ioState.value);
  if (ioState.outputPending || state.drawerMode !== 'io' || !state.selected || !['observed', 'partial'].includes(io.status) || !io.controlToken
    || !io.controlAuthorized || ioState.authorizedUntil <= Date.now()) return;
  const channel = io.doChannels.find(ch => ioChannelKey(ch) === key);
  if (!channel?.isValid || !channel.logicalName) return;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const requestId = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const id = state.selected;
  const command = { requestId, deviceName: channel.deviceName, channel: channel.channel, logicalName: channel.logicalName, value, expectedValue: channel.value };
  ioState.outputPending = command; ioState.outputResult = null; renderDetail();
  let result;
  try {
    const response = await fetch(`/api/robots/${encodeURIComponent(id)}/io/output`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IO-Control-Token': io.controlToken },
      body: JSON.stringify(command), signal: AbortSignal.timeout(8000)
    });
    const data = await response.json();
    if (data.pinRequired && ioState.value?.controlToken === io.controlToken) {
      ioState.authorizedUntil = 0; ioState.value.controlAuthorized = false;
    }
    const status = ['confirmed', 'rejected', 'unconfirmed'].includes(data.status) ? data.status : response.ok || response.status >= 500 ? 'unconfirmed' : 'rejected';
    const text = status === 'confirmed' ? `${channel.logicalName} · 논리 ${value ? 'ON' : 'OFF'} 확인`
      : status === 'rejected' ? `${channel.logicalName} · 요청 거부/실패: ${data.error || data.message || '드라이버 응답을 확인하세요.'}`
      : `${channel.logicalName} · 결과 미확인. 자동 재전송하지 않습니다.`;
    result = { status, text };
  } catch {
    result = { status: 'unconfirmed', text: `${channel.logicalName} · 결과 미확인. 자동 재전송하지 않습니다.` };
  }
  if (ioState.outputPending?.requestId === requestId && state.selected === id) {
    ioState.outputPending = null; ioState.outputResult = result; renderDetail();
  } else toast(`${id} · ${result.text}`);
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-io-output]');
  if (!button || button.disabled) return;
  const row = button.closest('[data-io-channel]');
  if (row) setIoOutput(row.dataset.ioChannel, Number(button.dataset.ioOutput));
});
