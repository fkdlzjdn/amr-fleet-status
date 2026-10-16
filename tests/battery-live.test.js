'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { BatteryLive } = require('../lib/battery-live');
const { Collector } = require('../lib/collector');
const { normalize } = require('../lib/normalize');
const { inventoryFile } = require('../lib/config');
const { openBatteryStream } = require('../lib/ssh-probe');
const { createApplication } = require('../server');
const entry = inventoryFile(path.join(__dirname, '..'))[5];
const raw = current => ({ ok: true, payload: { battery: { status: 'observed', percentage: 0.43, present: true, current,
  power_supply_status: 3, message_age_seconds: 0.01, source: 'ros2', topic: '/R_006/battery_state',
  current_profile: { plugin: 'spx_bms_slec_plugin', current_sign: 'positive_charging' } } } });
function fixture() {
  const collector = new Collector([entry], { statePath: '/nonexistent/battery-live-test.json' });
  collector.robots[0] = normalize(entry, 0, { ok: true, payload: { ...raw(7).payload,
    process_evidence: [{ generation: 'ros2', distro: 'jazzy', rid: 'R_006' }], static_evidence: [] } });
  return collector;
}

test('live battery starts with viewers, shares a stream, and changes charging without a fleet poll', t => {
  const collector = fixture(); let packet, opens = 0, closes = 0;
  const live = new BatteryLive(collector, { openStream: (_entry, onPacket) => { opens++; packet = onPacket; return { close() { closes++; } }; } });
  t.after(() => live.close()); const updates = []; live.on('battery', value => updates.push(value));
  assert.equal(opens, 0); const stop1 = live.watch(), stop2 = live.watch(); assert.equal(opens, 1);
  packet(raw(7)); assert.equal(updates.at(-1).battery.charging, true);
  packet(raw(-3)); assert.equal(updates.at(-1).battery.charging, false); assert.equal(updates.at(-1).battery.chargingState, 'discharging');
  packet(raw(0)); assert.equal(updates.at(-1).battery.chargingState, 'idle');
  assert.equal(collector.robots[0].battery.charging, true);
  assert.equal(live.snapshot(collector.snapshot()).robots[0].battery.charging, false);
  stop1(); assert.equal(closes, 0); stop2(); assert.equal(closes, 1); assert.equal(live.sessions.size, 0);
});

test('stream failure and stale data clear charging rather than restoring an older periodic value', t => {
  const collector = fixture(); let now = Date.now(), packet, ended;
  const live = new BatteryLive(collector, { now: () => now, openStream: (_entry, onPacket, onEnd) => {
    packet = onPacket; ended = onEnd; return { close() {} };
  } }); t.after(() => live.close());
  const stop = live.watch(); packet(raw(7)); now += 2500;
  const stale = live.snapshot(collector.snapshot()).robots[0].battery;
  assert.equal(stale.charging, null); assert.equal(stale.liveStatus, 'stale');
  packet(raw(7)); ended('connection_error');
  const failed = live.snapshot(collector.snapshot()).robots[0].battery;
  assert.equal(failed.charging, null); assert.equal(failed.liveStatus, 'reconnecting');
  stop(); assert.equal(live.watchers, 0);
});

test('removed robots stop battery readers and late packets cannot cross into a new range', t => {
  const collector = fixture(); let packet, closed = 0;
  const live = new BatteryLive(collector, { openStream: (_entry, onPacket) => { packet = onPacket; return { close() { closed++; } }; } });
  t.after(() => live.close()); live.watch(); let updates = 0; live.on('battery', () => updates++);
  collector.robots = []; collector.inventory = []; collector.emit('change');
  packet(raw(7)); assert.equal(closed, 1); assert.equal(updates, 0); assert.equal(live.sessions.size, 0);
});

test('fleet SSE delivers battery changes independently of its full snapshots and releases readers', async t => {
  const collector = fixture(); let packet, closes = 0;
  const live = new BatteryLive(collector, { openStream: (_entry, onPacket) => { packet = onPacket; return { close() { closes++; } }; } });
  const server = createApplication(collector, { batteryLive: live });
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  const events = await fetch(url + '/api/events'); const reader = events.body.getReader(); await reader.read();
  packet(raw(-2)); const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: battery/); assert.match(text, /"charging":false/);
  const api = await (await fetch(url + '/api/fleet')).json(); assert.equal(api.robots[0].battery.charging, false); assert.equal(api.robots[0].battery.live, true);
  await reader.cancel(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closes, 1);
});

test('battery SSH stream uses only the read-only battery command and has no DO capability', async t => {
  let stream;
  class Channel extends Duplex { constructor() { super(); this.stderr = new PassThrough(); } _read() {} _write(_chunk, _encoding, callback) { callback(); } }
  class Client extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('ready')); }
    exec(command, _options, callback) { assert.ok(command.includes('PROBE_MODE="battery_stream"')); assert.ok(!command.includes('PROBE_MODE="io_stream"')); stream = new Channel(); callback(null, stream); }
    end() { this.emit('close'); }
  }
  let received;
  const handle = openBatteryStream(entry, packet => { received = packet; }, () => {}, { username: 'mock', knownHosts: '' }, { ClientCtor: Client });
  t.after(() => handle.close()); assert.equal(typeof handle.setOutput, 'undefined');
  await new Promise(resolve => setImmediate(resolve)); stream.push(JSON.stringify({ schema_version: 1, battery: raw(7).payload.battery }) + '\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(received.payload.battery.current, 7);
});

test('Python persistent battery, current changes and lease termination tests pass', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'battery-stream-test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
