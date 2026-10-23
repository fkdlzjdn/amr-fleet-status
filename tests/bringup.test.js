'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { BringupService, loadProfiles } = require('../lib/bringup-service');
const { DoControl } = require('../lib/do-control');
const { Collector } = require('../lib/collector');
const { createApplication } = require('../server');
const { probeBringup, bringupRemoteCommand } = require('../lib/ssh-probe');
const robot = { expected_rid: 'R_006', ip: '192.168.20.56', ssh_port: 22, ssh_port_fallbacks: [] };
const profile = { rid: 'R_006', ip: robot.ip, domain: 6, files: [{ path: '.bash_aliases', sha256: '0'.repeat(64) }] };
const command = () => ({ requestId: 'a'.repeat(32), expectedRevision: 'b'.repeat(64) });
const reply = (state = 'stopped', status = 'observed') => ({ ok: true, sshConnected: true, payload: { bringup: { status,
  observed: { state, canStart: state === 'stopped', canStop: state === 'running', revision: 'b'.repeat(64), reason: '',
    process: state === 'running' ? { pid: 123, start: '10' } : null }, message: 'mock only' } } });

test('bringup profiles stay private and validate identities and relative startup paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-bringup-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config')); const file = path.join(root, 'config/bringup-control.json');
  fs.writeFileSync(file, JSON.stringify({ robots: [profile] })); assert.equal(loadProfiles(root).length, 1);
  fs.writeFileSync(file, JSON.stringify({ robots: [{ ...profile, files: [{ path: '../wrong', sha256: '0'.repeat(64) }] }] }));
  assert.throws(() => loadProfiles(root));
  assert.deepEqual(new BringupService([profile]).publicProfiles(), [{ id: profile.rid, ip: profile.ip }]);
});

test('bringup commands allow registered robots only, serialize, deduplicate and never retry uncertain writes', async () => {
  let calls = 0, resolve;
  const service = new BringupService([profile], { probe: async () => { calls++; return new Promise(done => { resolve = done; }); } });
  await assert.rejects(service.run({ ...robot, ip: '192.168.20.57' }, 'start', command()), { status: 409 });
  for (const invalid of [{ ...command(), command: 'arbitrary' }, { ...command(), requestId: ['a'.repeat(32)] }]) {
    await assert.rejects(service.run(robot, 'start', invalid), { status: 400 });
  }
  const first = service.run(robot, 'start', command()), duplicate = service.run(robot, 'start', command());
  await Promise.resolve(); assert.equal(calls, 1);
  await assert.rejects(service.run(robot, 'stop', { ...command(), requestId: 'c'.repeat(32) }), { status: 409 });
  resolve({ ok: false, sshConnected: true, error: 'probe_timeout' });
  assert.equal((await first).status, 'unconfirmed'); assert.equal((await duplicate).status, 'unconfirmed');
  await service.run(robot, 'start', command()); assert.equal(calls, 1);
  await assert.rejects(service.run(robot, 'stop', command()), { status: 409 });
});

async function apiFixture(t, policy) {
  let writes = 0;
  const service = new BringupService([profile], { probe: async (_robot, request) => {
    if (request.action !== 'status') writes++;
    return reply(request.action === 'start' ? 'running' : 'stopped', request.action === 'status' ? 'observed' : 'confirmed');
  } });
  const collector = new Collector([robot], { statePath: '/nonexistent/bringup-api-test.json' });
  const server = createApplication(collector, { bringupService: service, bringupControl: policy });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (action, body, token, origin = base) => fetch(base + '/api/robots/R_006/bringup/' + action, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Bringup-Control-Token': token || '' },
    body: JSON.stringify(body || {})
  });
  return { base, post, get writes() { return writes; } };
}
test('bringup API requires same origin and a robot-bound session, supports current no-PIN policy', async t => {
  const f = await apiFixture(t, new DoControl({ DO_CONTROL_ENABLED: 'true', DO_CONTROL_PIN_REQUIRED: 'false' }));
  assert.equal((await f.post('session', {}, '', 'http://other.example')).status, 403);
  assert.equal((await f.post('start', command())).status, 403);
  const session = await (await f.post('session')).json(); assert.equal(session.authorized, true);
  const status = await fetch(f.base + '/api/robots/R_006/bringup/status', { headers: { 'X-Bringup-Control-Token': session.token } });
  assert.equal((await status.json()).observed.state, 'stopped');
  assert.equal((await f.post('start', { ...command(), argv: ['wrong'] }, session.token)).status, 400); assert.equal(f.writes, 0);
  assert.equal((await f.post('start', command(), session.token)).status, 200);
  await f.post('start', command(), session.token); assert.equal(f.writes, 1);
  await f.post('lock', {}, session.token);
  assert.equal((await f.post('stop', { ...command(), requestId: 'c'.repeat(32) }, session.token)).status, 403);
});
test('bringup PIN policy remains available and master-disable denies all actions', async t => {
  const f = await apiFixture(t, new DoControl({ DO_CONTROL_ENABLED: 'true', DO_CONTROL_PIN: '836204' }));
  const session = await (await f.post('session')).json();
  assert.equal((await f.post('start', command(), session.token)).status, 403);
  assert.equal((await f.post('unlock', { pin: '000000' }, session.token)).status, 401);
  assert.equal((await f.post('unlock', { pin: '836204' }, session.token)).status, 200);
  assert.equal((await f.post('start', command(), session.token)).status, 200);
  const disabled = await apiFixture(t, new DoControl({}));
  const locked = await (await disabled.post('session')).json();
  assert.equal((await disabled.post('start', command(), locked.token)).status, 403); assert.equal(disabled.writes, 0);
});

test('SSH bringup transport uses fixed code and passes structured requests through stdin only', async () => {
  let received, sent;
  class Channel extends Duplex {
    constructor() { super(); this.stderr = new PassThrough(); }
    _read() {}
    _write(chunk, _encoding, done) {
      received = JSON.parse(chunk.toString()); done();
      queueMicrotask(() => { this.push(JSON.stringify({ schema_version: 1, bringup: { status: 'observed' } }) + '\n'); setImmediate(() => this.emit('close', 0)); });
    }
  }
  class Client extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('ready')); }
    exec(text, _options, done) { sent = text; done(null, new Channel()); }
    end() { this.emit('close'); }
  }
  const request = { action: 'status', profile };
  const result = await probeBringup(robot, request, { username: 'mock', knownHosts: '' }, { ClientCtor: Client });
  assert.equal(result.ok, true); assert.equal(sent, bringupRemoteCommand); assert.deepEqual(received, request);
});

test('Python lifecycle protection tests use mocked processes and signals only', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'bringup-worker-test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
