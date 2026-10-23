'use strict';
const bringupState = { token: null, value: null, pending: false, reading: false, message: '', resultKind: '',
  session: null, authorizedUntil: 0, timer: null, generation: 0, layout: null, receivedAt: 0 };
const bringupAvailability = new Map();
const bringupUrl = id => '/api/robots/' + encodeURIComponent(id) + '/bringup/';
function bringupButtons(robot) {
  const live = bringupAvailability.get(robot.id);
  const value = live && live.ip === robot.ip && live.at >= Date.parse(robot.observedAt || 0) ? live.state : robot.bringup;
  const labels = { running: '실행 중', stopped: '정지', starting: '시작 확인 중', not_applicable: '해당 없음', ambiguous: '실행 충돌' };
  const configured = state.settings?.bringupControl?.robots?.some(item => item.id === robot.id && item.ip === robot.ip);
  const supported = configured && robot.ssh === 'connected';
  return '<div class="bringup-cell"><span class="pill ' + (value === 'running' ? 'good' : 'neutral') + '">' +
    svg(value === 'running' ? 'check' : 'clock') + (labels[value] || '미확인') + '</span>' +
    '<button type="button" class="table-detail bringup-open" data-bringup="' + escapeHTML(robot.id) +
    '" title="' + (supported ? 'bringup 켜기 / 끄기' : '이 로봇의 기동 설정이 등록되지 않았습니다.') + '"' +
    (supported ? '' : ' disabled') + '>켜기 / 끄기</button></div>';
}
function renderBringupDetail(robot) {
  const current = bringupState.value?.observed;
  const session = bringupState.session;
  const authorized = session?.enabled && (!session.pinRequired || bringupState.authorizedUntil > Date.now());
  const fresh = current && Date.now() - bringupState.receivedAt < 5000;
  $('drawer-title').textContent = displayRid(robot) + ' · bringup 제어';
  $('drawer-check-time').textContent = bringupState.value?.checkedAt ? '상태 확인 ' + timeLabel(bringupState.value.checkedAt) : '실행 상태 확인 중';
  $('drawer-refresh').disabled = bringupState.pending || bringupState.reading;
  if (bringupState.layout !== robot.id) {
    bringupState.layout = robot.id;
    $('drawer-content').innerHTML =
      '<div class="bringup-intro"><code>' + escapeHTML(robot.ip) + ':' + robot.port + '</code>' +
      '<p>등록된 기존 bringup을 시작하거나 정상 종료합니다.</p></div>' +
      '<section class="bringup-state-box"><span>현재 bringup</span><strong id="bringup-current">확인 중</strong><small id="bringup-pid"></small></section>' +
      '<p id="bringup-reason" class="io-note"></p>' +
      '<section class="io-control-gate"><strong id="bringup-auth-status"></strong>' +
      '<form id="bringup-pin-form" hidden autocomplete="off"><label for="bringup-pin">제어 PIN</label><div>' +
      '<input id="bringup-pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autocomplete="off" placeholder="6~12자리 숫자">' +
      '<button id="bringup-pin-submit" class="button primary" type="submit">잠금 해제</button></div></form></section>' +
      '<div class="bringup-actions"><button type="button" id="bringup-start" disabled>bringup 켜기</button>' +
      '<button type="button" id="bringup-stop" disabled>bringup 끄기</button></div>' +
      '<p class="bringup-operation-note">켜기는 로봇 노드를 기동하고, 끄기는 현재 작업과 노드 연결을 종료할 수 있습니다. 실행 프로세스 확인과 장치 준비 상태는 별개입니다.</p>' +
      '<p id="bringup-feedback" class="io-output-feedback" role="status" hidden></p>';
    $('bringup-pin-form').onsubmit = unlockBringup;
    $('bringup-start').onclick = () => requestBringup('start');
    $('bringup-stop').onclick = () => requestBringup('stop');
  }
  const labels = { running: '실행 중', stopped: '정지', starting: '시작 확인 중', ambiguous: '실행 충돌', unknown: '미확인' };
  $('bringup-current').textContent = fresh ? labels[current.state] || '미확인' : '상태 확인 중';
  $('bringup-current').className = fresh && current.state === 'running' ? 'running' : '';
  $('bringup-pid').textContent = fresh && current.pid ? 'launch PID ' + current.pid : '';
  $('bringup-reason').textContent = current?.reason || '실시간 상태를 확인하고 요청합니다. 다른 실행이 있거나 등록 설정이 달라지면 요청을 차단합니다.';
  $('bringup-auth-status').textContent = !session ? '제어 연결 중…' : !session.enabled ? '서버에서 bringup 제어 비활성화'
    : !session.pinRequired ? 'PIN 없이 제어 가능' : authorized ? 'PIN 인증 완료 · 20분 유효' : 'PIN 인증 필요';
  $('bringup-pin-form').hidden = !session?.enabled || !session.pinRequired || authorized;
  $('bringup-pin-submit').disabled = bringupState.pending;
  $('bringup-start').disabled = !fresh || !authorized || !current.canStart || bringupState.pending;
  $('bringup-stop').disabled = !fresh || !authorized || !current.canStop || bringupState.pending;
  $('bringup-feedback').hidden = !bringupState.message;
  $('bringup-feedback').textContent = bringupState.message;
  $('bringup-feedback').className = 'io-output-feedback ' + bringupState.resultKind;
}
async function bringupRequest(id, action, body) {
  const response = await fetch(bringupUrl(id) + action, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bringup-Control-Token': bringupState.token || '' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(26000)
  });
  const result = await response.json();
  if (!response.ok && !result.status) {
    if (result.pinRequired) bringupState.authorizedUntil = 0;
    throw Object.assign(new Error(result.error || 'bringup 요청을 처리하지 못했습니다.'), { status: response.status });
  }
  return result;
}
function acceptBringupStatus(id, value) {
  bringupState.value = value; bringupState.receivedAt = Date.now();
  const robot = state.snapshot?.robots.find(item => item.id === id);
  if (robot && value.observed) bringupAvailability.set(id, { ip: robot.ip, state: value.observed.state, at: Date.now() });
  renderFleet(); renderDetail();
}
async function fetchBringupStatus() {
  if (state.drawerMode !== 'bringup' || !state.selected || document.hidden || bringupState.reading || bringupState.pending || !bringupState.token) return;
  const generation = bringupState.generation, id = state.selected;
  bringupState.reading = true;
  try {
    const result = await bringupRequest(id, 'status');
    if (generation === bringupState.generation && state.selected === id) acceptBringupStatus(id, result);
  } catch (error) {
    if (generation === bringupState.generation) {
      bringupState.value = null; bringupState.message = error.message; bringupState.resultKind = 'unconfirmed';
    }
  } finally {
    if (generation === bringupState.generation) { bringupState.reading = false; renderDetail(); }
  }
}
async function startBringupPanel() {
  const generation = bringupState.generation, id = state.selected;
  try {
    const result = await bringupRequest(id, 'session', {});
    if (generation !== bringupState.generation || state.selected !== id || state.drawerMode !== 'bringup') return;
    bringupState.token = result.token; bringupState.session = result;
    await fetchBringupStatus();
    if (generation !== bringupState.generation || state.selected !== id || state.drawerMode !== 'bringup') return;
    bringupState.timer = setInterval(() => {
      if (state.drawerMode === 'bringup') { renderDetail(); fetchBringupStatus(); }
    }, 2000);
  } catch (error) {
    if (generation === bringupState.generation) { bringupState.message = error.message; bringupState.resultKind = 'rejected'; renderDetail(); }
  }
}
function stopBringupPanel() {
  const token = bringupState.token, id = state.selected;
  bringupState.generation++; clearInterval(bringupState.timer);
  if (token && id) fetch(bringupUrl(id) + 'lock', { method: 'POST', headers: { 'X-Bringup-Control-Token': token } }).catch(() => {});
  Object.assign(bringupState, { token: null, value: null, pending: false, reading: false, message: '', resultKind: '',
    session: null, authorizedUntil: 0, timer: null, layout: null, receivedAt: 0 });
}
async function unlockBringup(event) {
  event.preventDefault();
  if (bringupState.pending || !bringupState.token) return;
  const id = state.selected, generation = bringupState.generation;
  const pin = $('bringup-pin').value; $('bringup-pin').value = '';
  bringupState.pending = true; bringupState.message = 'PIN 확인 중…'; renderDetail();
  try {
    const result = await bringupRequest(id, 'unlock', { pin });
    if (generation === bringupState.generation && result.authorized) {
      bringupState.authorizedUntil = Date.now() + result.expiresInMs;
      bringupState.message = ''; bringupState.resultKind = '';
    }
  } catch (error) {
    if (generation === bringupState.generation) { bringupState.message = error.message; bringupState.resultKind = 'rejected'; }
  } finally {
    if (generation === bringupState.generation) { bringupState.pending = false; renderDetail(); }
  }
}
async function requestBringup(action) {
  const value = bringupState.value?.observed, id = state.selected;
  const robot = state.snapshot?.robots.find(item => item.id === id);
  const button = $(action === 'start' ? 'bringup-start' : 'bringup-stop');
  if (!robot || button.disabled || bringupState.pending || !value?.revision) return;
  const label = action === 'start' ? '시작' : '종료';
  if (!window.confirm(displayRid(robot) + ' (' + robot.ip + ') bringup을 ' + label + '할까요?' +
    (action === 'stop' ? '\n현재 작업과 로봇 노드 연결이 종료될 수 있습니다.' : '\n등록된 기존 기동 설정으로 로봇 노드를 실행합니다.'))) return;
  const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  const generation = bringupState.generation;
  bringupState.pending = true; bringupState.message = 'bringup ' + label + ' 요청 처리 중…'; bringupState.resultKind = 'pending'; renderDetail();
  let result;
  try {
    result = await bringupRequest(id, action, { requestId, expectedRevision: value.revision });
  } catch (error) {
    result = { status: error.status >= 400 && error.status < 500 ? 'rejected' : 'unconfirmed', message: error.message + ' 자동 재전송하지 않습니다.' };
  }
  if (generation === bringupState.generation && state.selected === id) {
    bringupState.message = result.message || '요청 결과를 확인하세요.'; bringupState.resultKind = result.status;
    bringupState.pending = false;
    if (result.observed) acceptBringupStatus(id, result);
    await fetchBringupStatus(); renderDetail();
  } else toast(displayRid(robot) + ' · ' + (result.message || 'bringup 요청 결과를 확인하세요.'));
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-bringup]');
  if (button && !button.disabled && state.snapshot) openDetail(button.dataset.bringup, 'bringup');
});
document.addEventListener('visibilitychange', () => {
  if (state.drawerMode === 'bringup' && !document.hidden) fetchBringupStatus();
});
