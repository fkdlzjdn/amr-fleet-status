'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const { JogService } = require('../lib/jog-service');
const { DoControl } = require('../lib/do-control');
const { Collector } = require('../lib/collector');
const { createApplication } = require('../server');
const { openJogStream, jogRemoteCommand } = require('../lib/ssh-probe');
const robot = { expected_rid: 'R_006', ip: '192.168.20.56', ssh_port: 22 };
const profile = { rid: robot.expected_rid, ip: robot.ip, domain: 6 };
function fixture(t) {
  let now = 10000, closed = 0, packet;
  const sent = [];
  const service = new JogService([profile], { now: () => now, openStream(_robot, config, onPacket) {
    assert.deepEqual(config, { rid: 'R_006', domain: 6 });
    packet = onPacket;
    return { send(command) { sent.push(command); return true; }, close() { closed++; } };
  } });
  t.after(() => service.destroy());
  return { service, sent, ready: () => packet({ ok: true, payload: { jog: { status: 'ready', challenge: 'fresh' } } }),
    advance(ms) { now += ms; }, get closed() { return closed; } };
}
test('Jog uses registered ROS2 targets, one operator, fixed direction enums and no arbitrary velocities', t => {
  const f = fixture(t), s = f.service.open(robot);
  assert.equal(f.sent.length, 0);
  assert.throws(() => f.service.open(robot), { status: 409 });
  assert.throws(() => f.service.open({ ...robot, ip: '192.168.20.57' }), { status: 409 });
  f.ready();
  for (const bad of [{ direction: 'forward', sequence: 1, speed: 10 }, { direction: 'up', sequence: 1 },
    { direction: 'forward', sequence: 1.5 }]) assert.throws(() => f.service.command(s, bad), { status: 400 });
  assert.equal(f.sent.length, 0);
  f.service.command(s, { direction: 'forward', sequence: 1 });
  f.service.command(s, { direction: 'stop', sequence: 3 });
  assert.throws(() => f.service.command(s, { direction: 'forward', sequence: 2 }), { status: 409 });
  assert.equal(f.sent.at(-1).direction, 'stop');
  assert.equal(f.service.status(s).linearSpeed, 0.25);
});
test('stale graph blocks movement; closing, inventory removal and missing browser polling stop and close SSH', t => {
  const f = fixture(t), s = f.service.open(robot);
  f.ready(); f.advance(501);
  assert.throws(() => f.service.command(s, { direction: 'forward', sequence: 1 }), { status: 409 });
  assert.equal(f.sent.at(-1).direction, 'stop');
  f.service.prune([]); assert.equal(f.closed, 1); assert.throws(() => f.service.get(robot, s.token), { status: 403 });
  f.service.open(robot); f.advance(3001); f.service.expire(); assert.equal(f.closed, 2);
});
test('opening and closing an untouched panel does not request velocity ownership', t => {
  const f = fixture(t), session = f.service.open(robot);
  f.ready(); f.service.close(session.token);
  assert.deepEqual(f.sent, []); assert.equal(f.closed, 1);
});
test('independent 0..1 speeds propagate while invalid speeds never reach the worker', t => {
  const f = fixture(t), session = f.service.open(robot);
  f.ready();
  for (const [sequence, linearSpeed, angularSpeed] of [[1, 0, 1], [2, 1, 0], [3, 0.42, 0.76]]) {
    f.service.command(session, { direction: 'forward', sequence, linearSpeed, angularSpeed });
    assert.equal(f.sent.at(-1).linearSpeed, linearSpeed);
    assert.equal(f.sent.at(-1).angularSpeed, angularSpeed);
  }
  const count = f.sent.length;
  for (const value of [-0.01, 1.01, NaN, Infinity, true, null, '0.5']) for (const key of ['linearSpeed', 'angularSpeed']) {
    assert.throws(() => f.service.command(session, { direction: 'left', sequence: 10, [key]: value }), { status: 400 });
  }
  assert.throws(() => f.service.command(session, { direction: 'left', sequence: 10, immediate: true }), { status: 400 });
  assert.equal(f.sent.length, count);
  f.service.command(session, { direction: 'stop', sequence: 11, immediate: true });
  assert.equal(f.sent.at(-1).immediate, true);
  assert.equal(f.service.status(session).linearSpeed, 0.42);
});
test('Jog HTTP enforces Origin, robot-bound token and PIN but permits stop after PIN expiry', async t => {
  const f = fixture(t);
  let now = 10000;
  const policy = new DoControl({ DO_CONTROL_ENABLED: 'true', DO_CONTROL_PIN: '836204' }, { now: () => now, sessionMs: 1000 });
  const collector = new Collector([robot, { ...robot, expected_rid: 'R_011', ip: '192.168.20.61' }], { statePath: '/nonexistent/jog-test.json' });
  const server = createApplication(collector, { jogService: f.service, bringupProfiles: [], bringupControl: policy });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (action, body, token = '', origin = base, id = 'R_006') => fetch(base + '/api/robots/' + id + '/jog/' + action, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Jog-Control-Token': token }, body: JSON.stringify(body || {}) });
  assert.equal((await post('session', {}, '', 'http://other')).status, 403);
  const session = await (await post('session')).json(); f.ready();
  assert.equal((await post('command', { direction: 'forward', sequence: 1 }, session.token)).status, 403);
  assert.equal((await post('command', { direction: 'forward', sequence: 1 }, session.token, base, 'R_011')).status, 403);
  assert.equal((await post('unlock', { pin: '836204' }, session.token)).status, 200);
  assert.equal((await post('command', { direction: 'forward', sequence: 1, linearSpeed: 0.72, angularSpeed: 1.0 }, session.token)).status, 200);
  assert.equal(f.sent.at(-1).linearSpeed, 0.72); assert.equal(f.sent.at(-1).angularSpeed, 1);
  const sentBeforeInvalid = f.sent.length;
  assert.equal((await post('command', { direction: 'forward', sequence: 2, linearSpeed: 1.01 }, session.token)).status, 400);
  assert.equal(f.sent.length, sentBeforeInvalid);
  now += 1001;
  assert.equal((await post('command', { direction: 'forward', sequence: 2 }, session.token)).status, 403);
  assert.equal((await post('command', { direction: 'stop', sequence: 3 }, session.token)).status, 200);
  assert.equal(f.sent.at(-1).direction, 'stop');
  await post('close', {}, session.token);
  assert.equal((await post('command', { direction: 'forward', sequence: 4 }, session.token)).status, 403);
});
test('robot-side speed, input expiry and out-of-order protection use simulated time only', () => {
  const result = spawnSync('python3', ['-B', 'tests/jog-worker-test.py'], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('Jog SSH uses fixed code, sends profiles and directions as JSON, and exposes no DO method', async t => {
  let stream, packet;
  const inputs = [];
  class Channel extends Duplex {
    constructor() { super(); this.stderr = new PassThrough(); }
    _read() {}
    _write(chunk, _encoding, callback) { for (const line of chunk.toString().split('\n').filter(Boolean)) inputs.push(JSON.parse(line)); callback(); }
  }
  class Client extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('ready')); }
    exec(command, _options, done) { assert.equal(command, jogRemoteCommand); stream = new Channel(); done(null, stream); }
    end() { this.emit('close'); }
  }
  const handle = openJogStream(robot, profile, value => { packet = value; }, () => {},
    { username: 'mock', knownHosts: '' }, { ClientCtor: Client });
  t.after(() => handle.close());
  assert.equal(handle.setOutput, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(inputs[0], { profile });
  stream.push(JSON.stringify({ schema_version: 1, jog: { status: 'ready', challenge: 'fresh' } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packet.payload.jog.status, 'ready');
  assert.equal(handle.send({ direction: 'stop', sequence: 1 }), true);
  assert.deepEqual(inputs.at(-1), { direction: 'stop', sequence: 1 });
  handle.close(); assert.equal(handle.send({ direction: 'forward', sequence: 2 }), false);
});
