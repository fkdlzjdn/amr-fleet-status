'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeBattery, normalize } = require('../lib/normalize');
const { Collector } = require('../lib/collector');
const { createApplication } = require('../server');
const { inventoryFile } = require('../lib/config');
const entry = inventoryFile(path.join(__dirname, '..'))[5];
const battery = { status: 'observed', percentage: 0.825, voltage: 51.2, current: -2, present: true, power_supply_status: 2, source: 'ros2', topic: '/R_006/bms_node/battery_state', message_age_seconds: 0.1 };
const response = value => ({ ok: true, payload: { process_evidence: [], static_evidence: [], battery: value } });

test('battery percentages use 0..1, keep zero valid, and never guess 0..100 input', () => {
  assert.equal(normalizeBattery(battery).percent, 82.5);
  assert.equal(normalizeBattery({ ...battery, percentage: 0 }).percent, 0);
  assert.equal(normalizeBattery({ ...battery, percentage: 1 }).percent, 100);
  for (const percentage of [-1, 80, null, '0.8', NaN, Infinity]) {
    const result = normalizeBattery({ ...battery, percentage });
    assert.equal(result.percent, null); assert.equal(result.status, 'invalid');
  }
  for (const value of [{ ...battery, message_age_seconds: 100 }, { ...battery, present: false }, { status: 'timeout', percentage: 0.8 }]) {
    assert.equal(normalizeBattery(value).percent, null);
  }
  assert.equal(normalizeBattery().percent, null);
  assert.equal(normalizeBattery({ ...battery, power_supply_status: 1 }).charging, true);
  for (const power_supply_status of [2, 3, 4]) assert.equal(normalizeBattery({ ...battery, power_supply_status }).charging, false);
  for (const power_supply_status of [0, 5, null]) assert.equal(normalizeBattery({ ...battery, power_supply_status }).charging, null);
  const chargingWithoutPercent = normalizeBattery({ ...battery, percentage: null, power_supply_status: 1 });
  assert.equal(chargingWithoutPercent.percent, null);
  assert.equal(chargingWithoutPercent.charging, true);
  assert.ok(chargingWithoutPercent.observedAt);
  for (const status of ['timeout', 'stale', 'not_present']) {
    assert.equal(normalizeBattery({ ...battery, status, power_supply_status: 1 }).charging, null);
  }
  assert.equal(normalizeBattery({ ...battery, percentage: null, message_age_seconds: 100, power_supply_status: 1 }).charging, null);
});

test('failed, stale and restarted collection never presents cached battery as current', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-battery-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const statePath = path.join(folder, 'state.json');
  const success = normalize(entry, 0, response(battery), null, new Date(Date.now() - 100000).toISOString());
  const failed = normalize(entry, 0, { ok: false, error: 'timeout' }, success);
  assert.equal(failed.battery.percent, null); assert.equal(failed.previous.battery.percent, 82.5);
  const c = new Collector([entry], { statePath }); c.robots[0] = success;
  const stale = c.snapshot().robots[0];
  assert.equal(stale.battery.status, 'stale'); assert.equal(stale.battery.percent, null); assert.equal(stale.previous.battery.percent, 82.5);
  c.persist(); const restored = new Collector([entry], { statePath }).robots[0];
  assert.equal(restored.battery.percent, null); assert.equal(restored.previous.battery.percent, 82.5);
  assert.equal(normalize(entry, 0, response({ status: 'no_topic' }), success).battery.percent, null);
});

test('battery reaches fleet API and SSE without starting any real SSH reads', async t => {
  const collector = new Collector([entry], { statePath: '/nonexistent/battery-test.json' });
  collector.robots[0] = normalize(entry, 0, response(battery));
  const server = createApplication(collector);
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const snapshot = await (await fetch(url + '/api/fleet')).json();
  assert.equal(snapshot.robots[0].battery.percent, 82.5);
  const events = await fetch(url + '/api/events');
  const reader = events.body.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"percent":82.5/); await reader.cancel();
});

test('UI renders empty and zero battery distinctly and exports numeric percent to CSV', () => {
  const nodes = new Map();
  const getNode = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, innerHTML: '', textContent: '' }); return nodes.get(id); };
  let exported;
  const context = vm.createContext({ console, setTimeout: () => {}, clearTimeout: () => {},
    document: { addEventListener() {}, getElementById: getNode, createElement: () => ({ click() {} }) },
    Blob: class { constructor(parts) { exported = parts.join(''); } }, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} } });
  const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/init\(\);\s*$/, '');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/io.js'), 'utf8'), context);
  vm.runInContext(script, context);
  const zero = normalize(entry, 0, response({ ...battery, percentage: 0 }));
  context.robots = [zero];
  vm.runInContext('state.snapshot = { robots, generatedAt: new Date().toISOString() }; renderFleet(); exportCSV();', context);
  assert.match(getNode('robot-table').innerHTML, /value="0"/);
  assert.match(getNode('robot-table').innerHTML, /0%/);
  assert.match(exported, /배터리 잔량/); assert.match(exported, /,"0",/);
  context.robots = [normalize(entry, 0, response({ status: 'no_topic' }))];
  vm.runInContext('state.snapshot.robots = robots; renderFleet(); exportCSV();', context);
  assert.match(getNode('robot-table').innerHTML, /배터리 토픽 없음/);
  assert.doesNotMatch(getNode('robot-table').innerHTML, /0%/);
  assert.match(getNode('robot-table').innerHTML, /충전 상태 미확인/);
  for (const [status, label] of [[1, '충전 중'], [2, '충전 안 함 · 방전 중'], [3, '충전 안 함'], [4, '충전 완료'], [0, '충전 상태 미확인']]) {
    context.robots = [normalize(entry, 0, response({ ...battery, power_supply_status: status }))];
    vm.runInContext('state.snapshot.robots = robots; renderFleet(); exportCSV();', context);
    assert.ok(getNode('robot-table').innerHTML.includes(label));
    assert.ok(exported.includes(label));
  }
  context.robots = [normalize(entry, 0, response({ ...battery, percentage: null, power_supply_status: 1 }))];
  vm.runInContext('state.snapshot.robots = robots; renderFleet(); exportCSV();', context);
  assert.match(getNode('robot-table').innerHTML, /충전 중/);
  assert.match(getNode('robot-table').innerHTML, /미확인/);
  context.robots = [normalize(entry, 0, response({ ...battery, current: 7.93, power_supply_status: 3,
    current_profile: { plugin: 'spx_bms_slec_plugin', current_sign: 'positive_charging' },
    io_charging: { status: 'observed', charging: true, message_age_seconds: 0.01 } }))];
  vm.runInContext('state.snapshot.robots = robots; renderFleet(); exportCSV();', context);
  assert.match(getNode('robot-table').innerHTML, /충전 중/); assert.match(getNode('robot-table').innerHTML, /battery-charge charging/);
  assert.match(exported, /배터리 전류/);
});

test('Python subscription and timeout tests pass', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'battery-probe-test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('verified SLEC current resolves charging despite BMS status 3 without guessing other driver signs', () => {
  const profile = { plugin: 'spx_bms_slec_plugin', current_sign: 'positive_charging' };
  const io_charging = { status: 'observed', charging: true, message_age_seconds: 0.01, topic: '/R_006/io/state_monitor/charging' };
  const r56 = normalizeBattery({ ...battery, current: 7.93, power_supply_status: 3, current_profile: profile, io_charging });
  assert.equal(r56.charging, true); assert.equal(r56.chargingSource, 'battery_current'); assert.equal(r56.chargingConflict, true);
  assert.equal(r56.powerSupplyStatus, 3); assert.equal(r56.ioCharging.charging, true);
  const discharge = normalizeBattery({ ...battery, current: -5, current_profile: profile, io_charging });
  assert.equal(discharge.charging, false); assert.equal(discharge.chargingState, 'discharging');
  const idle = normalizeBattery({ ...battery, current: 0.05, power_supply_status: 3, current_profile: profile, io_charging });
  assert.equal(idle.charging, false); assert.equal(idle.chargingState, 'idle');
  const unknown = normalizeBattery({ ...battery, current: 7.93, power_supply_status: 0, io_charging });
  assert.equal(unknown.charging, null); assert.equal(unknown.chargingState, 'signal');
  const disagreement = normalizeBattery({ ...battery, power_supply_status: 3, io_charging });
  assert.equal(disagreement.charging, null); assert.equal(disagreement.chargingState, 'conflict');
  const stale = normalizeBattery({ ...battery, status: 'stale', current_profile: profile, io_charging: { ...io_charging, message_age_seconds: 4 } });
  assert.equal(stale.charging, null); assert.equal(stale.ioCharging.status, 'stale');
});
