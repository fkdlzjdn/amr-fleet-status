'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { IoService } = require('../lib/io-service');
const { openIoStream } = require('../lib/ssh-probe');
const { Collector } = require('../lib/collector');
const { inventoryFile } = require('../lib/config');
const { createApplication } = require('../server');
const robot = inventoryFile(path.join(__dirname, '..'))[5];
const sample = () => ({ ok: true, payload: { io: { status: 'observed', message_age_seconds: 0.05,
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r56-io-status.json'), 'utf8')) } } });
const command = () => ({ requestId: 'a'.repeat(32), deviceName: 'ezi_io_main', channel: 0, logicalName: 'front_reset', value: 1, expectedValue: 0 });
const confirmed = cmd => ({ request_id: cmd.requestId, status: 'confirmed', logical_value: cmd.value, may_have_applied: true, message: 'Confirmed by mock driver' });

test('DO requests require a fresh unique valid output and deduplicate dispatched commands', async () => {
  let packet, calls = 0, resolveOutput;
  const service = new IoService({ openStream: (_robot, onPacket) => {
    packet = onPacket;
    return { close() {}, setOutput: cmd => { calls++; return new Promise(resolve => { resolveOutput = () => resolve(confirmed(cmd)); }); } };
  } });
  await assert.rejects(service.setOutput(robot, command()), { status: 409 });
  const stop = service.subscribe(robot, () => {}); packet(sample());
  for (const invalid of [{ ...command(), value: true }, { ...command(), value: 2 }, { ...command(), service: '/other' }, { ...command(), requestId: ['a'.repeat(32)] }]) {
    await assert.rejects(service.setOutput(robot, invalid), { status: 400 });
  }
  for (const invalid of [{ ...command(), logicalName: 'lift_up', expectedValue: 1 }, { ...command(), expectedValue: 1 }, { ...command(), deviceName: 'other' }]) {
    await assert.rejects(service.setOutput(robot, invalid), { status: 409 });
  }
  assert.equal(calls, 0);
  const first = service.setOutput(robot, command()), duplicate = service.setOutput(robot, command());
  await Promise.resolve(); assert.equal(calls, 1);
  await assert.rejects(service.setOutput(robot, { ...command(), requestId: 'b'.repeat(32) }), { status: 409 });
  resolveOutput(); assert.equal((await first).status, 'confirmed'); assert.deepEqual(await duplicate, await first);
  await service.setOutput(robot, command()); assert.equal(calls, 1);
  await assert.rejects(service.setOutput(robot, { ...command(), value: 0 }), { status: 409 });
  service.streams.get(service.key(robot)).last.checkedAt = new Date(Date.now() - 3000).toISOString();
  await assert.rejects(service.setOutput(robot, { ...command(), requestId: 'c'.repeat(32) }), { status: 409 });
  stop();
});

test('DO HTTP endpoint requires same origin and a token belonging to an open IO viewer', async t => {
  let packet, calls = 0;
  const service = new IoService({ openStream: (_robot, onPacket) => {
    packet = onPacket; return { close() {}, setOutput: async cmd => { calls++; return confirmed(cmd); } };
  } });
  const collector = new Collector([robot], { statePath: '/nonexistent/do-http-test.json' });
  const server = createApplication(collector, { ioService: service });
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  const post = headers => fetch(url + '/api/robots/R_006/io/output', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(command()) });
  assert.equal((await post({ Origin: url })).status, 403);
  const events = await fetch(url + '/api/robots/R_006/io/events'), reader = events.body.getReader(); packet(sample());
  let text = '';
  while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value);
  const value = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6)); const token = value.controlToken;
  assert.equal(typeof token, 'string');
  assert.equal((await post({ 'X-IO-Control-Token': token })).status, 403);
  assert.equal((await post({ Origin: 'http://other.example', 'X-IO-Control-Token': token })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await (await post({ Origin: url, 'X-IO-Control-Token': token })).json()).status, 'confirmed'); assert.equal(calls, 1);
  await post({ Origin: url, 'X-IO-Control-Token': token }); assert.equal(calls, 1);
  await reader.cancel(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await post({ Origin: url, 'X-IO-Control-Token': token })).status, 403); assert.equal(calls, 1);
});

test('SSH DO transport sends one fixed command and correlates responses without replay', async t => {
  let stream;
  class Channel extends Duplex {
    constructor() { super(); this.writes = []; this.stderr = new PassThrough(); }
    _read() {}
    _write(chunk, _encoding, callback) { this.writes.push(chunk.toString()); callback(); }
  }
  class FakeClient extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('ready')); }
    exec(commandText, _options, callback) { assert.ok(commandText.includes('PROBE_MODE="io_stream"')); stream = new Channel(); callback(null, stream); }
    end() { this.emit('close'); }
  }
  let packets = 0;
  const handle = openIoStream(robot, () => packets++, () => {}, { username: 'mock', knownHosts: '' }, { ClientCtor: FakeClient });
  t.after(() => handle.close()); await new Promise(resolve => setImmediate(resolve));
  stream.push(JSON.stringify({ schema_version: 1, io: { status: 'loading' } }) + '\n');
  const result = handle.setOutput(command());
  const sent = stream.writes.filter(line => line.trim()).map(line => JSON.parse(line));
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'set_output'); assert.equal(sent[0].logicalName, 'front_reset');
  stream.push(JSON.stringify({ schema_version: 1, control: confirmed(command()) }) + '\n');
  assert.equal((await result).status, 'confirmed'); assert.equal(packets, 1);
  const unknown = handle.setOutput({ ...command(), requestId: 'b'.repeat(32) }); handle.close();
  assert.equal((await unknown).status, 'unconfirmed'); assert.equal(stream.writes.filter(line => line.trim()).length, 2);
});

test('Python DO protection, logical readback and no-retry tests pass with mock services only', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'io-output-test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
