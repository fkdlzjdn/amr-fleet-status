'use strict';
const jogState = { token: null, session: null, value: null, receivedAt: 0, sequence: 0,
  generation: 0, holdGeneration: 0, held: null, timer: null, poll: null, layout: null, message: '',
  linearSpeed: 0.25, angularSpeed: 0.25, speedValid: true, key: null };
const jogKeys = { KeyW: 'forward', KeyA: 'left', KeyS: 'stop', KeyD: 'right', KeyX: 'backward' };
function jogKeyCode(event) {
  return event.code || ({ w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', x: 'KeyX', ' ': 'Space', enter: 'Enter' })[event.key?.toLowerCase()];
}
function jogEditingTarget(target) {
  return Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
}
const jogUrl = (id, action) => '/api/robots/' + encodeURIComponent(id) + '/jog/' + action;
function jogButton(robot) {
  const configured = state.settings?.jogControl?.robots?.some(p => p.id === robot.id && p.ip === robot.ip);
  if (!configured) return '';
  return '<button type="button" class="table-detail jog-open" data-jog="' + escapeHTML(robot.id) + '"' +
    (robot.ssh === 'connected' ? '' : ' disabled') + '>↕ JOG 조작</button>';
}
function renderJogLauncher() {
  const launcher = $('jog-launcher');
  if (!launcher) return;
  const profiles = state.settings?.jogControl?.robots || [];
  launcher.hidden = !profiles.length;
  const robots = (state.snapshot?.robots || []).filter(robot => robot.ssh === 'connected'
    && profiles.some(p => p.id === robot.id && p.ip === robot.ip));
  const select = $('jog-target'), open = $('jog-launch');
  const selected = robots.find(robot => robot.id === select.value) || robots[0];
  const options = robots.map(robot => '<option value="' + escapeHTML(robot.id) + '">' +
    escapeHTML(displayRid(robot) + ' · ' + robot.ip) + '</option>').join('') || '<option value="">연결된 대상 없음</option>';
  if (select.dataset.options !== options) { select.innerHTML = options; select.dataset.options = options; }
  select.value = selected?.id || '';
  select.disabled = !selected;
  open.disabled = !selected;
  open.dataset.jog = selected?.id || '';
  select.onchange = () => { open.dataset.jog = select.value; };
}
function jogReady() {
  return Boolean(jogState.token && jogState.session?.authorized && jogState.value?.status === 'ready'
    && jogState.speedValid && Date.now() - jogState.receivedAt < 700 && !document.hidden);
}
function jogMotionActive() {
  return Boolean(jogState.held || Math.abs(jogState.value?.outputLinear || 0) > 0.0001 || Math.abs(jogState.value?.outputAngular || 0) > 0.0001);
}
function jogSpeedControl(axis, label, unit, value) {
  return '<article class="jog-speed-control"><div class="jog-speed-heading"><label for="jog-' + axis + '-speed">' + label +
    ' <small>' + unit + '</small></label><input id="jog-' + axis + '-speed" type="number" min="0" max="1" step="0.01" value="' + value +
    '" required></div><input id="jog-' + axis + '-slider" type="range" min="0" max="1" step="0.01" value="' + value +
    '" aria-label="' + label + ' 조절"><div class="jog-speed-scale"><small>0</small><small>1.0</small></div></article>';
}
function renderJogDetail(robot) {
  $('drawer-title').textContent = displayRid(robot) + ' · JOG 조작';
  $('drawer-check-time').textContent = '선속도 ' + jogState.linearSpeed.toFixed(2) + ' m/s · 회전속도 ' + jogState.angularSpeed.toFixed(2) + ' rad/s';
  $('drawer-refresh').disabled = false;
  if (jogState.layout !== robot.id) {
    jogState.layout = robot.id;
    $('drawer-content').innerHTML = '<div class="bringup-intro"><code>' + escapeHTML(robot.ip) + ':' + robot.port + '</code>' +
      '<p>AUTO · MANUAL 모두 사용할 수 있습니다. 누르면 가속하고, 손을 떼면 감속합니다.</p></div>' +
      '<div class="jog-speeds">' + jogSpeedControl('linear', '선속도', 'm/s', jogState.linearSpeed) +
      jogSpeedControl('angular', '회전속도', 'rad/s', jogState.angularSpeed) + '</div>' +
      '<p class="jog-ramp-note">가속 / 감속 · 직진 0.3 / 0.6 m/s² · 회전 0.6 / 1.2 rad/s²</p>' +
      '<p id="jog-status" class="io-note" role="status"></p>' +
      '<p class="jog-keyboard-hint">키보드 <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>X</kbd> · 누르는 동안 조작, 떼면 감속</p>' +
      '<form id="jog-pin-form" hidden autocomplete="off"><label for="jog-pin">제어 PIN</label><div>' +
      '<input id="jog-pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autocomplete="off">' +
      '<button type="submit" class="button primary">잠금 해제</button></div></form>' +
      '<div class="jog-pad" aria-label="수동 이동">' +
      '<button type="button" class="jog-forward" data-jog-direction="forward" disabled>↑<span>전진</span><kbd aria-hidden="true">W</kbd></button>' +
      '<button type="button" class="jog-left" data-jog-direction="left" disabled>↶<span>좌회전</span><kbd aria-hidden="true">A</kbd></button>' +
      '<button type="button" class="jog-stop" id="jog-stop" disabled>■<span>정지</span><kbd aria-hidden="true">S</kbd></button>' +
      '<button type="button" class="jog-right" data-jog-direction="right" disabled>↷<span>우회전</span><kbd aria-hidden="true">D</kbd></button>' +
      '<button type="button" class="jog-backward" data-jog-direction="backward" disabled>↓<span>후진</span><kbd aria-hidden="true">X</kbd></button></div>' +
      '<p id="jog-output" class="jog-ramp-note"></p>' +
      '<p class="bringup-operation-note">손을 떼면 감속 후 0 속도를 유지합니다. 정지 버튼·연결 이상 시에는 즉시 0 명령을 보냅니다. AUTO에서는 패널을 닫으면 기존 자동 주행 명령이 다시 적용될 수 있습니다. 로봇의 기존 보호 조건이 적용됩니다.</p>' +
      '<p id="jog-feedback" class="io-output-feedback" role="status" hidden></p>';
    for (const button of $('drawer-content').querySelectorAll('[data-jog-direction]')) {
      button.onpointerdown = event => {
        if (event.button !== 0 || button.disabled || jogState.held) return;
        event.preventDefault(); button.focus(); button.setPointerCapture(event.pointerId);
        beginJog(button.dataset.jogDirection);
      };
      button.onpointerup = () => endJog();
      button.onpointercancel = button.onlostpointercapture = () => endJog(false, true);
      button.onkeydown = event => {
        if (![' ', 'Enter'].includes(event.key)) return;
        event.preventDefault(); if (!event.repeat) beginJog(button.dataset.jogDirection, jogKeyCode(event));
      };
      button.onblur = () => endJog(false, true);
      button.oncontextmenu = event => event.preventDefault();
    }
    $('jog-stop').onclick = () => endJog(true, true);
    for (const axis of ['linear', 'angular']) {
      const number = $('jog-' + axis + '-speed'), slider = $('jog-' + axis + '-slider');
      const change = event => {
        const value = Number(event.target.value);
        if (event.target.value === '' || !Number.isFinite(value) || value < 0 || value > 1) {
          jogState.speedValid = false; jogState.message = '속도는 0~1.0 범위로 입력하세요.';
          endJog(false, true); renderDetail(); return;
        }
        jogState[axis + 'Speed'] = value;
        if (event.target === number) slider.value = String(value); else number.value = String(value);
        jogState.speedValid = ['linear', 'angular'].every(a => $('jog-' + a + '-speed').checkValidity());
        if (jogState.speedValid) jogState.message = '';
        renderDetail();
      };
      number.oninput = slider.oninput = change;
    }
    $('jog-pin-form').onsubmit = async event => {
      event.preventDefault();
      const generation = jogState.generation;
      const pin = $('jog-pin').value; $('jog-pin').value = '';
      try {
        const result = await jogRequest('unlock', { pin });
        if (generation !== jogState.generation) return;
        jogState.session.authorized = result.authorized; jogState.message = ''; renderDetail();
      } catch (error) { if (generation === jogState.generation) { jogState.message = error.message; renderDetail(); } }
    };
  }
  const ready = jogReady(), authorized = jogState.session?.authorized;
  const labels = { forward: '전진', backward: '후진', left: '좌회전', right: '우회전' };
  const mode = { auto: 'AUTO', manual: 'MANUAL', unknown: '모드 미확인' }[jogState.value?.operatingMode || 'unknown'];
  const output = jogState.value;
  const decelerating = output?.direction === 'stop' && (Math.abs(output?.outputLinear || 0) > 0.0001 || Math.abs(output?.outputAngular || 0) > 0.0001);
  $('jog-status').textContent = !jogState.token ? '제어 연결 중…' : !authorized ? 'PIN 인증 필요'
    : !jogState.speedValid ? '속도 입력을 확인하세요.'
    : !ready ? jogState.value?.reason || '로봇 응답 확인 중입니다.'
    : mode + ' · ' + (decelerating ? '감속 중' : jogState.value.direction && jogState.value.direction !== 'stop' ? labels[jogState.value.direction] + ' 명령 전송 중' : 'JOG 준비 · 방향 버튼을 누르세요.');
  $('jog-output').textContent = Number.isFinite(output?.outputLinear) && Number.isFinite(output?.outputAngular) && Date.now() - jogState.receivedAt < 700
    ? '출력 속도 명령 · ' + output.outputLinear.toFixed(2) + ' m/s · ' + output.outputAngular.toFixed(2) + ' rad/s' : '';
  $('jog-pin-form').hidden = !jogState.session?.pinRequired || Boolean(authorized);
  for (const button of $('drawer-content').querySelectorAll('[data-jog-direction]')) {
    button.disabled = !ready || Boolean(jogState.held && jogState.held !== button.dataset.jogDirection);
    button.setAttribute('aria-pressed', String(jogState.held === button.dataset.jogDirection));
  }
  $('jog-stop').disabled = !jogState.token;
  $('jog-feedback').hidden = !jogState.message;
  $('jog-feedback').textContent = jogState.message;
}
async function jogRequest(action, body, id = state.selected, token = jogState.token) {
  const response = await fetch(jogUrl(id, action), { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jog-Control-Token': token || '' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'JOG 요청을 처리하지 못했습니다.');
  return value;
}
async function fetchJogStatus() {
  const generation = jogState.generation;
  if (!jogState.token || document.hidden || state.drawerMode !== 'jog') return;
  try {
    const value = await jogRequest('status');
    if (generation !== jogState.generation) return;
    jogState.value = value; jogState.receivedAt = Date.now(); jogState.session.authorized = value.authorized;
    if (!jogReady()) endJog(jogMotionActive(), true);
    renderDetail();
  } catch (error) {
    if (generation !== jogState.generation) return;
    endJog(jogMotionActive(), true); jogState.value = null; jogState.message = error.message; renderDetail();
  } finally {
    if (generation === jogState.generation) jogState.poll = setTimeout(fetchJogStatus, 200);
  }
}
async function startJogPanel() {
  const generation = jogState.generation, id = state.selected;
  try {
    const session = await jogRequest('session', {}, id);
    if (generation !== jogState.generation) { closeJogSession(id, session.token); return; }
    jogState.token = session.token; jogState.session = session;
    await fetchJogStatus();
  } catch (error) { if (generation === jogState.generation) { jogState.message = error.message; renderDetail(); } }
}
function beginJog(direction, key = null) {
  if (!jogReady() || jogState.held) return;
  jogState.held = direction; jogState.key = key; jogState.message = '';
  const generation = ++jogState.holdGeneration;
  renderDetail();
  const step = async () => {
    if (generation !== jogState.holdGeneration) return;
    if (!jogReady()) { endJog(false, true); return; }
    try {
      await jogRequest('command', { direction, sequence: ++jogState.sequence, linearSpeed: jogState.linearSpeed, angularSpeed: jogState.angularSpeed });
      if (generation === jogState.holdGeneration) jogState.timer = setTimeout(step, 100);
    } catch (error) {
      if (generation === jogState.holdGeneration) { endJog(false, true); jogState.message = error.message; renderDetail(); }
    }
  };
  step();
}
function endJog(force = false, immediate = false) {
  const held = jogState.held;
  jogState.held = null; jogState.key = null; jogState.holdGeneration++; clearTimeout(jogState.timer);
  if ((held || force) && jogState.token) {
    jogRequest('command', { direction: 'stop', sequence: ++jogState.sequence, immediate }).catch(() => {});
    if (state.drawerMode === 'jog') renderDetail();
  }
}
function closeJogSession(id, token) {
  fetch(jogUrl(id, 'close'), { method: 'POST', headers: { 'X-Jog-Control-Token': token }, keepalive: true }).catch(() => {});
}
function stopJogPanel() {
  endJog(jogMotionActive(), true);
  if (jogState.token && state.selected) closeJogSession(state.selected, jogState.token);
  clearTimeout(jogState.poll);
  Object.assign(jogState, { token: null, session: null, value: null, receivedAt: 0, sequence: 0,
    generation: jogState.generation + 1, layout: null, message: '', linearSpeed: 0.25, angularSpeed: 0.25, speedValid: true });
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-jog]');
  if (button && !button.disabled && state.snapshot) openDetail(button.dataset.jog, 'jog');
});
window.addEventListener('blur', () => endJog(jogMotionActive(), true));
window.addEventListener('pagehide', stopJogPanel);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopJogPanel();
  else if (state.drawerMode === 'jog' && state.selected) { renderDetail(); startJogPanel(); }
});
document.addEventListener('keydown', event => {
  const code = jogKeyCode(event), direction = jogKeys[code];
  if (!direction || state.drawerMode !== 'jog' || !state.selected || document.hidden
    || event.ctrlKey || event.altKey || event.metaKey || event.isComposing
    || jogEditingTarget(event.target) || jogEditingTarget(document.activeElement)) return;
  event.preventDefault();
  if (event.repeat) return;
  if (direction === 'stop') { if (jogState.token) endJog(true, true); }
  else if (jogReady() && !jogState.held) {
    $('drawer-content')?.querySelector('[data-jog-direction="' + direction + '"]')?.focus({ preventScroll: true });
    beginJog(direction, code);
  }
});
document.addEventListener('keyup', event => {
  if (jogState.key && jogKeyCode(event) === jogState.key) { event.preventDefault(); endJog(); }
});
document.addEventListener('focusin', () => { if (jogState.key) endJog(false, true); });
