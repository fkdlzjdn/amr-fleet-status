'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Collector } = require('../lib/collector');
const { initialRobot, normalize, summarize } = require('../lib/normalize');
const { hostKeys, verifyHost, hostAlgorithms } = require('../lib/known-hosts');
const { inventoryFile } = require('../lib/config');
const { remoteCommand } = require('../lib/ssh-probe');
const { createApplication } = require('../server');
const { DoControl } = require('../lib/do-control');
const inventory = inventoryFile(path.join(__dirname, '..'));
function ros2(rid = 'R_006', model = 'sl400_vri') {
  return { schema_version: 1, hostname: 'syscon', installed_distros: ['jazzy', 'noetic'], boot_id: 'boot-a', os: { VERSION_ID: '24.04' },
    process_evidence: [{ generation: 'ros2', distro: 'jazzy', model, rid, bringup: true, pid: 42 }], static_evidence: [], process_scan_complete: true,
    scorpion: { load_state: 'not-found', active_state: 'inactive', sub_state: 'dead', main_pid: 0 }, errors: [] };
}
const success = payload => ({ ok: true, reached: true, sshConnected: true, port: 22, payload });

test('R_006 live-shaped evidence resolves ROS2 Jazzy and scorpion absence independently', () => {
  const r = normalize(inventory[5], 5, success(ros2()));
  assert.equal(r.observedRid, 'R_006'); assert.equal(r.model, 'sl400_vri');
  assert.equal(r.configuredRos, 'ros2'); assert.equal(r.activeRos, 'ros2'); assert.equal(r.distro, 'Jazzy');
  assert.equal(r.service, 'not_found'); assert.equal(r.bringup, 'running'); assert.equal(r.needsAttention, false);
});
test('ROS1 configuration is identified independently of inactive runtime and service enablement', () => {
  const p = ros2(); p.process_evidence = []; p.static_evidence = [{ key: 'ROS_DISTRO', value: 'noetic', source: '.bashrc' }, { key: 'ROBOT_MODEL', value: 'sr1', source: 'scorpion.sh' }];
  p.scorpion = { load_state: 'loaded', active_state: 'inactive', sub_state: 'dead', unit_file_state: 'enabled' };
  const r = normalize(inventory[0], 0, success(p));
  assert.equal(r.configuredRos, 'ros1'); assert.equal(r.activeRos, 'stopped'); assert.equal(r.model, 'sr1');
  assert.equal(r.service, 'inactive'); assert.equal(r.serviceEnabled, true);
});
test('an installed ROS directory alone does not establish configuration or running state', () => {
  const p = ros2(); p.process_evidence = []; p.process_scan_complete = false;
  const r = normalize(inventory[0], 0, success(p));
  assert.equal(r.configuredRos, 'unknown'); assert.equal(r.activeRos, 'unknown'); assert.equal(r.distro, null);
});
test('RID/model conflicts remain visible rather than being filled from expected inventory', () => {
  const p = ros2('R_007'); p.process_evidence.push({ generation: 'ros2', distro: 'jazzy', model: 'sr3', rid: 'R_007', bringup: true, pid: 43 });
  const r = normalize(inventory[5], 5, success(p));
  assert.equal(r.observedRid, 'R_007'); assert.equal(r.model, null); assert.ok(r.needsAttention);
  assert.ok(r.issues.some(s => s.includes('RID 불일치'))); assert.equal(r.sources.model.length, 2);
});
test('authentication and host-key failures are not interpreted as power off', () => {
  for (const error of ['auth_failed', 'host_key_unknown', 'host_key_mismatch']) {
    const r = normalize(inventory[5], 5, { ok: false, error, reached: true });
    assert.equal(r.reachability, 'reachable'); assert.equal(r.model, null); assert.equal(r.service, 'unknown');
  }
});
test('failed observation keeps previous known values separate from current fields', () => {
  const previous = normalize(inventory[5], 5, success(ros2()));
  const failed = normalize(inventory[5], 5, { ok: false, error: 'no_route' }, previous);
  assert.equal(failed.model, null); assert.equal(failed.configuredRos, 'unknown');
  assert.equal(failed.previous.model, 'sl400_vri'); assert.equal(failed.reachability, 'unreachable');
});
test('repeated authenticated probe failures preserve the last actual success', () => {
  const successValue = normalize(inventory[5], 5, success(ros2()));
  const failure = { ok: false, sshConnected: true, reached: true, error: 'probe_timeout' };
  const first = normalize(inventory[5], 5, failure, successValue);
  const second = normalize(inventory[5], 5, failure, first);
  assert.equal(second.model, null); assert.equal(second.previous.model, 'sl400_vri');
  assert.equal(second.previous.observedAt, successValue.observedAt);
});
test('pending inventory is not filled with simulated data and summary is exhaustive', () => {
  const robots = inventory.map(initialRobot), s = summarize(robots);
  assert.equal(robots.length, 50); assert.equal(s.pending, 50); assert.equal(s.unknown, 50);
  assert.equal(s.reachable + s.unreachable + s.unknown, 50);
  assert.ok(robots.every(r => r.model === null && r.observedAt === null));
});
test('known_hosts verifies hashes, ports, key changes and revocation', () => {
  const key = Buffer.from('public-host-key'), other = Buffer.from('changed-host-key'), salt = Buffer.from('random-salt');
  const hash = crypto.createHmac('sha1', salt).update('192.168.20.56').digest('base64');
  const text = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}\n[192.168.20.75]:2222 ssh-rsa ${key.toString('base64')}`;
  assert.ok(verifyHost(hostKeys(text, '192.168.20.56', 22), key));
  assert.equal(verifyHost(hostKeys(text, '192.168.20.56', 22), other), false);
  assert.equal(verifyHost(hostKeys(text, '192.168.20.75', 22), key), false);
  assert.ok(verifyHost(hostKeys(text, '192.168.20.75', 2222), key));
  assert.deepEqual(hostAlgorithms(hostKeys(text, '192.168.20.75', 2222)), ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
  const revoked = `192.168.20.56 ssh-ed25519 ${key.toString('base64')}\n@revoked 192.168.20.56 ssh-ed25519 ${key.toString('base64')}`;
  assert.equal(verifyHost(hostKeys(revoked, '192.168.20.56', 22), key), false);
});
test('collector bounds concurrency, deduplicates requests and restores cache as history only', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  let active = 0, peak = 0, calls = 0;
  const c = new Collector(inventory.slice(0, 8), { concurrency: 2, statePath: path.join(folder, 'state.json'), probe: async entry => {
    active++; peak = Math.max(peak, active); calls++; await new Promise(r => setTimeout(r, 10)); active--; return success(ros2(entry.expected_rid));
  } });
  c.start(); c.refresh(); c.refresh('R_006');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Collector stalled')), 2000);
    const onChange = () => { if (c.completed.size === 8 && c.active.size === 0) { clearTimeout(timeout); c.removeListener('change', onChange); resolve(); } };
    c.on('change', onChange);
  });
  c.stop(); assert.equal(peak, 2); assert.equal(calls, 8); assert.equal(c.snapshot().mode, 'live');
  const restored = new Collector(inventory.slice(0, 8), { statePath: path.join(folder, 'state.json') });
  assert.equal(restored.robots[0].model, null); assert.equal(restored.robots[0].quality, 'pending'); assert.ok(restored.robots[0].previous);
});
test('old successful values are marked stale rather than displayed as current health', () => {
  const c = new Collector(inventory.slice(5, 6), { statePath: '/nonexistent/fleet-test.json' });
  c.robots[0] = normalize(inventory[5], 0, success(ros2()), null, new Date(Date.now() - 100000).toISOString());
  const r = c.snapshot().robots[0]; assert.equal(r.quality, 'stale'); assert.equal(r.model, null); assert.equal(r.previous.model, 'sl400_vri');
});
test('live API exposes no password/private key and refresh only queues registered reads', async t => {
  const c = new Collector(inventory, { statePath: '/nonexistent/fleet-test.json' }); const calls = [];
  c.refresh = id => { calls.push(id || 'all'); return true; };
  const server = createApplication(c, { doControl: new DoControl({}) }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeClients(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(url + '/api/health')).json(); assert.equal(health.mode, 'live'); assert.equal(health.readOnly, true); assert.equal(health.ioOutputControl, false);
  const settings = await (await fetch(url + '/api/settings')).json(); assert.equal(typeof settings.keyConfigured, 'boolean');
  assert.ok(!Object.hasOwn(settings, 'password') && !Object.hasOwn(settings, 'privateKey'));
  assert.equal((await fetch(url + '/api/robots/R_006/refresh', { method: 'POST' })).status, 202); assert.deepEqual(calls, ['R_006']);
  assert.equal((await fetch(url + '/api/robots/R_999/refresh', { method: 'POST' })).status, 404);
  assert.equal((await fetch(url + '/api/demo/refresh', { method: 'POST' })).status, 404);
  assert.equal((await fetch(url + '/api/fleet/refresh', { method: 'POST', headers: { Origin: 'http://unrelated.example' } })).status, 403);
});
test('the remote probe is fixed read-only source and cannot accept web commands', () => {
  assert.ok(remoteCommand.startsWith('python3 -B -c'));
  const source = fs.readFileSync(path.join(__dirname, '../lib/robot-probe.py'), 'utf8');
  assert.ok(source.includes("['systemctl', 'show', 'scorpion.service'"));
  assert.ok(!/\b(?:rostopic\s+pub|ros2\s+(?:topic\s+pub|param\s+set)|systemctl\s+(?:start|restart|stop)|sudo)\b/.test(source));
});

const { DEFAULT_RANGE, validateRange, inventoryForRange, saveRange, loadRange } = require('../lib/config');
test('scan range validates IPv4/order/size and preserves port overrides and unknown RID mapping', () => {
  assert.deepEqual(validateRange(DEFAULT_RANGE), { ...DEFAULT_RANGE, total: 50 });
  for (const range of [
    { startIp: '192.168.20.100', endIp: '192.168.20.51' },
    { startIp: '192.168.20.01', endIp: '192.168.20.55' },
    { startIp: '192.168.20.999', endIp: '192.168.20.999' },
    { startIp: '192.168.20.0', endIp: '192.168.21.0' },
    { startIp: '8.8.8.8', endIp: '8.8.8.9' },
    { startIp: '192.168.20.51;id', endIp: '192.168.20.55' }
  ]) assert.throws(() => validateRange(range));
  const entries = inventoryForRange({ startIp: '192.168.20.74', endIp: '192.168.20.76' }, inventory);
  assert.equal(entries.length, 3); assert.equal(entries[1].ssh_port, 2222); assert.equal(entries[1].expected_rid, 'R_025');
  const other = inventoryForRange({ startIp: '10.0.1.255', endIp: '10.0.2.1' }, inventory);
  assert.deepEqual(other.map(e => e.ip), ['10.0.1.255', '10.0.2.0', '10.0.2.1']);
  const r = normalize(other[0], 0, success(ros2('R_099')));
  assert.equal(r.plannedRid, null); assert.equal(r.observedRid, 'R_099'); assert.ok(!r.issues.some(s => s.includes('RID 불일치')));
});
test('range reconfiguration ignores superseded in-flight results and retains global concurrency', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-range-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const jobs = []; let active = 0, peak = 0;
  const c = new Collector(inventory.slice(0, 2), { concurrency: 1, statePath: path.join(folder, 'state.json'), probe: entry => {
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => jobs.push({ ip: entry.ip, done: () => { active--; resolve(success(ros2(entry.expected_rid))); } }));
  } }); t.after(() => c.stop()); c.start();
  assert.equal(jobs.length, 1);
  const range = validateRange({ startIp: '192.168.20.56', endIp: '192.168.20.56' });
  c.reconfigure(inventoryForRange(range, inventory), range);
  assert.equal(jobs.length, 1); assert.equal(c.queue.length, 1);
  jobs[0].done(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.length, 2); assert.equal(c.completed.size, 0); assert.equal(c.robots[0].ip, '192.168.20.56'); assert.equal(c.robots[0].model, null);
  c.refresh(); assert.equal(c.queue.length, 0);
  jobs[1].done(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.completed.size, 1); assert.equal(c.robots[0].observedRid, 'R_006'); assert.equal(peak, 1);
  const nextRange = validateRange({ startIp: '192.168.20.55', endIp: '192.168.20.56' });
  c.stop(); c.reconfigure(inventoryForRange(nextRange, inventory), nextRange);
  assert.equal(c.robots[1].observedRid, 'R_006'); assert.equal(c.robots[1].number, 2);
});
test('settings API persists range, rejects invalid and cross-origin requests, and survives reload', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-range-api-')); const rangePath = path.join(folder, 'scan-range.json');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  assert.deepEqual(loadRange(rangePath), validateRange(DEFAULT_RANGE));
  const c = new Collector(inventory, { statePath: path.join(folder, 'state.json') });
  const server = createApplication(c, { rangePath, inventory }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeClients(); server.close(); }); const url = `http://127.0.0.1:${server.address().port}`;
  const post = (range, origin) => fetch(url + '/api/settings/range', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(range) });
  assert.equal((await post({ startIp: 'bad', endIp: 'bad' })).status, 400); assert.equal(fs.existsSync(rangePath), false);
  assert.equal((await post(DEFAULT_RANGE, 'http://unrelated.example')).status, 403);
  const range = { startIp: '192.168.20.56', endIp: '192.168.20.61' };
  const response = await post(range); assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.snapshot.robots.length, 6); assert.equal(result.range.total, 6); assert.deepEqual(loadRange(rangePath), validateRange(range));
  const settings = await (await fetch(url + '/api/settings')).json(); assert.deepEqual(settings.range, validateRange(range));
  assert.equal((await post({ startIp: '192.168.20.100', endIp: '192.168.20.56' })).status, 400); assert.deepEqual(loadRange(rangePath), validateRange(range));
  const unknownRange = { startIp: '10.0.0.1', endIp: '10.0.0.1' }; await post(unknownRange);
  assert.equal((await fetch(url + '/api/robots/IP_10_0_0_1/refresh', { method: 'POST' })).status, 202);
  await post(DEFAULT_RANGE); assert.equal(c.inventory.length, 50); assert.deepEqual(loadRange(rangePath), validateRange(DEFAULT_RANGE));
});
