'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { IoService, normalizeIo } = require('../lib/io-service');
const { Collector } = require('../lib/collector');
const { createApplication } = require('../server');
const { inventoryFile } = require('../lib/config');
const { normalize } = require('../lib/normalize');
const robots = inventoryFile(path.join(__dirname, '..'));
const raw = () => ({ status: 'observed', topic: '/R_006/io/status', node: '/R_006/io_driver_node', message_age_seconds: 0.1,
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r56-io-status.json'), 'utf8')) });
const response = io => ({ ok: true, payload: { io } });

test('IO reference fixture preserves raw ON/OFF and rejects invalid and duplicate channels', () => {
  const result = normalizeIo(response(raw()));
  assert.equal(result.status, 'observed'); assert.equal(result.diChannels.length, 8); assert.equal(result.doChannels.length, 8);
  assert.equal(result.diChannels[0].state, 'on'); assert.equal(result.diChannels[1].state, 'off');
  for (const change of [{ is_valid: false }, { value: null }, { value: 0.5 }, { value: '1' }, { io_type: 1 }, { channel_id: -1 }]) {
    const source = raw(); Object.assign(source.di_channels[0], change);
    const invalid = normalizeIo(response(source));
    assert.equal(invalid.status, 'partial'); assert.equal(invalid.diChannels[0].state, 'unknown'); assert.equal(invalid.diChannels[0].value, null);
  }
  const source = raw(); source.di_channels.push({ ...source.di_channels[0] });
  const duplicates = normalizeIo(response(source));
  assert.equal(duplicates.diChannels[0].state, 'unknown'); assert.equal(duplicates.invalidCount, 2);
});

test('IO failure, stale messages and malformed arrays expose no current channel values', () => {
  for (const source of [{ ...raw(), status: 'timeout' }, { ...raw(), message_age_seconds: 30 }, { ...raw(), message_age_seconds: null },
    { ...raw(), di_channels: null }, { ...raw(), di_channels: Array(257).fill({}) }]) {
    const value = normalizeIo(response(source));
    assert.notEqual(value.status, 'observed'); assert.deepEqual(value.diChannels, []); assert.deepEqual(value.doChannels, []);
  }
  assert.equal(normalizeIo({ ok: false, error: 'auth_failed' }).status, 'auth_failed');
});

test('IO requests share in-flight work, cache briefly, bound concurrency and clear failed work', async () => {
  let clock = 0, calls = 0; const jobs = [];
  const service = new IoService({ now: () => clock, maxActive: 1, probe: () => { calls++; return new Promise(resolve => jobs.push(resolve)); } });
  const first = service.read(robots[5]), duplicate = service.read(robots[5]);
  assert.equal((await service.read(robots[6])).status, 'busy');
  await Promise.resolve(); assert.equal(calls, 1);
  jobs[0](response(raw())); assert.deepEqual(await first, await duplicate);
  await service.read(robots[5]); assert.equal(calls, 1);
  clock = 2000; const next = service.read(robots[5]); await Promise.resolve(); assert.equal(calls, 2);
  jobs[1]({ ok: false, error: 'timeout' }); assert.equal((await next).status, 'timeout'); assert.equal(service.inFlight.size, 0);
  const failed = new IoService({ probe: async () => { throw new Error('secret connection details'); } });
  const failure = await failed.read(robots[5]); assert.equal(failure.status, 'unavailable'); assert.ok(!JSON.stringify(failure).includes('secret'));
});

test('IO API only reads registered robots, rejects output operations and discards removed targets', async t => {
  const collector = new Collector(robots.slice(5, 6), { statePath: '/nonexistent/fleet-io-test.json' });
  let calls = 0, resolveRead;
  const ioService = { read: robot => { calls++; assert.equal(robot.ip, '192.168.20.56'); return new Promise(resolve => { resolveRead = resolve; }); } };
  const server = createApplication(collector, { ioService });
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/api/robots/R_999/io')).status, 404); assert.equal(calls, 0);
  for (const endpoint of ['/api/robots/R_006/io', '/api/robots/R_006/io/set_output']) {
    assert.equal((await fetch(url + endpoint, { method: 'POST' })).status, 404);
  }
  const pending = fetch(url + '/api/robots/R_006/io');
  while (!resolveRead) await new Promise(resolve => setImmediate(resolve));
  collector.inventory = []; resolveRead(normalizeIo(response(raw())));
  assert.equal((await pending).status, 404);
  collector.inventory = [robots[5]]; resolveRead = null;
  const valid = fetch(url + '/api/robots/R_006/io?command=ignored');
  while (!resolveRead) await new Promise(resolve => setImmediate(resolve));
  resolveRead(normalizeIo(response(raw())));
  assert.equal((await (await valid).json()).diChannels.length, 8);
});

test('IO UI distinguishes ON, OFF and unknown, escapes names and ages out snapshots', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, escapeHTML: value => String(value).replace(/</g, '&lt;').replace(/"/g, '&quot;') });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/io.js'), 'utf8'), context);
  context.value = normalizeIo(response(raw()));
  assert.equal(vm.runInContext('ioView(value).status', context), 'observed');
  const cards = vm.runInContext('ioChannelCards(value.diChannels)', context);
  assert.match(cards, /ON · 1/); assert.match(cards, /OFF · 0/);
  context.value.diChannels[0] = { ...context.value.diChannels[0], logicalName: '<script>alert(1)</script>', isValid: false };
  const unknown = vm.runInContext('ioChannelCards([value.diChannels[0]])', context);
  assert.match(unknown, /미확인/); assert.doesNotMatch(unknown, /ON · 1/); assert.doesNotMatch(unknown, /<script>/);
  context.value.checkedAt = new Date(Date.now() - 11000).toISOString();
  assert.equal(vm.runInContext('ioView(value).status', context), 'stale');
  assert.equal(vm.runInContext('ioView(value).diChannels.length', context), 0);
  context.value.checkedAt = new Date(Date.now() - 1000).toISOString(); context.value.messageAgeSeconds = 9.5;
  assert.equal(vm.runInContext('ioView(value).status', context), 'stale');
});

test('Python IO node identity, schema and timeout checks pass', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'io-probe-test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('live IO shares one subscription, pushes each sample and closes after the last viewer', () => {
  let callbacks, opens = 0, closes = 0, now = 1000;
  const service = new IoService({ maxActive: 1, now: () => now, openStream: (_robot, packet, end) => {
    opens++; callbacks = { packet, end }; return { close() { closes++; } };
  } });
  const first = [], second = [], busy = [];
  const stopFirst = service.subscribe(robots[5], (value, ended) => first.push({ value, ended }));
  const stopSecond = service.subscribe(robots[5], (value, ended) => second.push({ value, ended }));
  service.subscribe(robots[6], (value, ended) => busy.push({ value, ended }));
  assert.equal(opens, 1); assert.equal(busy[0].value.status, 'busy'); assert.equal(busy[0].ended, true);
  callbacks.packet(response(raw())); now += 50;
  const changed = raw(); changed.di_channels[0].value = 0; callbacks.packet(response(changed));
  assert.equal(first.length, 2); assert.equal(second.length, 2);
  assert.equal(first[1].value.diChannels[0].state, 'off'); assert.equal(first[1].value.intervalMs, 50); assert.equal(first[1].value.live, true);
  stopFirst(); assert.equal(closes, 0); stopSecond(); assert.equal(closes, 1); assert.equal(service.streams.size, 0);
});

test('live IO discards old channel values on disconnect and closes removed targets', () => {
  let packet, end, closes = 0;
  const service = new IoService({ openStream: (_robot, onPacket, onEnd) => {
    packet = onPacket; end = onEnd; return { close() { closes++; } };
  } });
  const events = []; service.subscribe(robots[5], (value, ended) => events.push({ value, ended }));
  packet(response(raw())); end('probe_timeout');
  assert.equal(events.at(-1).ended, true); assert.deepEqual(events.at(-1).value.diChannels, []); assert.equal(service.streams.size, 0);
  service.subscribe(robots[5], (value, ended) => events.push({ value, ended }));
  service.prune([]); assert.equal(closes, 1); assert.equal(events.at(-1).value.status, 'removed'); assert.equal(service.streams.size, 0);
});

test('IO SSE sends live data and releases the stream when the browser disconnects', async t => {
  let packet, opens = 0, closes = 0;
  const service = new IoService({ openStream: (_robot, onPacket) => { opens++; packet = onPacket; return { close() { closes++; } }; } });
  const collector = new Collector(robots.slice(5, 6), { statePath: '/nonexistent/io-sse-test.json' });
  const server = createApplication(collector, { ioService: service });
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/api/robots/R_999/io/events')).status, 404);
  const stream = await fetch(url + '/api/robots/R_006/io/events'); const reader = stream.body.getReader();
  packet(response(raw())); let text = '';
  while (!text.includes('event: io')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"live":true/); assert.match(text, /"state":"on"/); assert.equal(opens, 1);
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closes, 1); assert.equal(service.streams.size, 0);
});

test('IO button distinguishes running, stopped and unknown, and lists channels in physical order', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, displayRid: robot => robot.id,
    escapeHTML: value => String(value).replace(/</g, '&lt;').replace(/"/g, '&quot;') });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/io.js'), 'utf8'), context);
  for (const [running, expected] of [[true, 'running'], [false, 'stopped']]) {
    const robot = normalize(robots[5], 0, { ok: true, payload: { process_evidence: [], static_evidence: [], process_scan_complete: true, io_driver: { running } } });
    assert.equal(robot.ioDriverStatus, expected); context.robot = robot;
    const html = vm.runInContext('ioButton(robot)', context);
    assert.ok(html.includes(`io-check-button ${expected}`)); assert.equal(html.includes(' disabled'), !running);
  }
  context.robot = normalize(robots[5], 0, { ok: false, error: 'timeout' });
  assert.equal(context.robot.ioDriverStatus, 'unknown'); assert.match(vm.runInContext('ioButton(robot)', context), /IO 확인/);
  context.value = normalizeIo(response(raw())); context.value.diChannels.reverse();
  const board = vm.runInContext('ioDeviceBoards(value)', context);
  assert.ok(board.indexOf('DI 00') < board.indexOf('DI 07')); assert.equal((board.match(/class="io-device"/g) || []).length, 1);
  context.value.checkedAt = new Date(Date.now() - 2500).toISOString(); context.value.live = true;
  assert.equal(vm.runInContext('ioView(value).status', context), 'stale');
});
