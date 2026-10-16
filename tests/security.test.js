'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DoControl } = require('../lib/do-control');
const { Collector } = require('../lib/collector');
const { IoService } = require('../lib/io-service');
const { inventoryFile, loadEnv } = require('../lib/config');
const { createApplication } = require('../server');
// Deliberately public fixture value, never used in deployment.
const testPin = '836204';
const enabledEnv = { DO_CONTROL_ENABLED: 'true', DO_CONTROL_PIN: testPin };
const inventory = inventoryFile(path.join(__dirname, '..')).slice(5, 7);
const rawIo = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r56-io-status.json'), 'utf8'));
const command = () => ({ requestId: 'e'.repeat(32), deviceName: 'ezi_io_main', channel: 0, logicalName: 'front_reset', value: 1, expectedValue: 0 });

async function fixture(t, options = {}) {
  let calls = 0;
  const commands = [];
  const collector = new Collector(inventory, { statePath: '/nonexistent/pin-test.json' });
  const ioService = new IoService({ openStream: (_robot, packet) => {
    queueMicrotask(() => packet({ ok: true, payload: { io: { ...rawIo, status: 'observed', message_age_seconds: 0.01 } } }));
    return { close() {}, setOutput: async cmd => {
      calls++; commands.push(cmd); return { request_id: cmd.requestId, status: 'confirmed', logical_value: cmd.value };
    } };
  } });
  const doControl = options.doControl || new DoControl(enabledEnv);
  const server = createApplication(collector, { ioService, doControl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeClients(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (action, token, body = {}, id = 'R_006') => fetch(`${url}/api/robots/${id}/io/${action}`, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-IO-Control-Token': token }, body: JSON.stringify(body)
  });
  async function viewer(id = 'R_006') {
    const response = await fetch(`${url}/api/robots/${id}/io/events`), reader = response.body.getReader();
    let text = '';
    while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value);
    const value = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6));
    return { token: value.controlToken, value, close: () => reader.cancel() };
  }
  return { url, post, viewer, collector, ioService, server, commands, get calls() { return calls; } };
}

test('DO defaults to disabled and .env can explicitly configure a valid PIN without exposing it', async t => {
  for (const env of [{}, { DO_CONTROL_ENABLED: 'true' }, { DO_CONTROL_PIN: testPin },
    { DO_CONTROL_ENABLED: 'true', DO_CONTROL_PIN: '123' }, { DO_CONTROL_ENABLED: 'false', DO_CONTROL_PIN: testPin }]) {
    const guard = new DoControl(env); assert.equal(guard.enabled, false); assert.equal(guard.authorized({ authorizedUntil: Infinity }), false);
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-pin-env-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, '.env'); fs.writeFileSync(file, `DO_CONTROL_ENABLED=true\nDO_CONTROL_PIN=${testPin}\n`);
  const env = {}; loadEnv(file, env); assert.equal(new DoControl(env).enabled, true);
  const f = await fixture(t, { doControl: new DoControl({}) });
  for (const endpoint of ['/api/health', '/api/settings', '/api/fleet']) {
    const response = await fetch(f.url + endpoint); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes(testPin));
    if (endpoint === '/api/health') assert.equal(JSON.parse(text).ioOutputControl, false);
  }
  const v = await f.viewer(); assert.equal(v.value.controlEnabled, false);
  assert.equal((await f.post('unlock', v.token, { pin: testPin })).status, 403);
  assert.equal((await f.post('output', v.token, command())).status, 403);
  assert.equal((await f.post('charge', v.token, { requestId: 'f'.repeat(32), value: 1, expectedValue: 0 })).status, 403);
  assert.equal(f.calls, 0); await v.close();
});

test('charging endpoint requires PIN and chooses only charge_relay on the server', async t => {
  const f = await fixture(t), v = await f.viewer();
  const charge = { requestId: 'f'.repeat(32), value: 1, expectedValue: 0 };
  assert.equal((await f.post('charge', v.token, charge)).status, 403); assert.equal(f.calls, 0);
  await f.post('unlock', v.token, { pin: testPin });
  assert.equal((await f.post('charge', v.token, { ...charge, logicalName: 'front_reset' })).status, 400);
  assert.equal(f.calls, 0);
  const result = await f.post('charge', v.token, charge); assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'confirmed');
  assert.equal(f.commands[0].logicalName, 'charge_relay'); assert.equal(f.commands[0].channel, 1);
  await f.post('charge', v.token, charge); assert.equal(f.calls, 1);
  await f.post('lock', v.token);
  assert.equal((await f.post('charge', v.token, charge)).status, 403); assert.equal(f.calls, 1);
  await v.close();
});

test('PIN unlock authorizes only that viewer/robot, expires, locks and never appears in responses', async t => {
  let now = Date.now(); const guard = new DoControl(enabledEnv, { now: () => now });
  const f = await fixture(t, { doControl: guard }), first = await f.viewer(), second = await f.viewer();
  assert.equal(first.value.controlAuthorized, false);
  assert.equal((await f.post('output', first.token, command())).status, 403);
  assert.equal((await f.post('unlock', first.token, { pin: '000000' })).status, 401);
  const unlocked = await f.post('unlock', first.token, { pin: testPin }); assert.equal(unlocked.status, 200);
  const reply = await unlocked.text(); assert.ok(!reply.includes(testPin)); assert.equal(JSON.parse(reply).expiresInMs, 300000);
  assert.equal((await f.post('output', second.token, command())).status, 403);
  assert.equal((await f.post('output', first.token, command(), 'R_007')).status, 403);
  assert.equal((await f.post('output', first.token, command())).status, 200); assert.equal(f.calls, 1);
  assert.equal((await f.post('lock', first.token)).status, 200);
  assert.equal((await f.post('output', first.token, command())).status, 403);
  await f.post('unlock', first.token, { pin: testPin }); now += 300001;
  assert.equal((await f.post('output', first.token, command())).status, 403);
  await f.post('unlock', first.token, { pin: testPin });
  await first.close(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.post('output', first.token, command())).status, 403); assert.equal(f.calls, 1);
  for (const endpoint of ['/api/health', '/api/settings', '/api/fleet', '/io.js']) assert.ok(!(await (await fetch(f.url + endpoint)).text()).includes(testPin));
  await second.close();
});

test('PIN retry budget spans tokens, sends Retry-After, and resets after the cooldown', async t => {
  let now = Date.now(); const f = await fixture(t, { doControl: new DoControl(enabledEnv, { now: () => now }) });
  const a = await f.viewer(), b = await f.viewer();
  for (let i = 0; i < 5; i++) assert.equal((await f.post('unlock', i % 2 ? a.token : b.token, { pin: '000000' })).status, 401);
  const limited = await f.post('unlock', b.token, { pin: testPin }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  now += 60001; assert.equal((await f.post('unlock', b.token, { pin: testPin })).status, 200);
  assert.equal(f.calls, 0); await a.close(); await b.close();
});

test('authorization is rechecked after reading a slow DO body', async t => {
  let now = Date.now(); const f = await fixture(t, { doControl: new DoControl(enabledEnv, { now: () => now }) }), v = await f.viewer();
  await f.post('unlock', v.token, { pin: testPin });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(f.url + '/api/robots/R_006/io/output', { method: 'POST', headers: {
      Origin: f.url, 'Content-Type': 'application/json', 'X-IO-Control-Token': v.token
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); const body = JSON.stringify(command()); request.write(body.slice(0, 5));
    setTimeout(() => { now += 300001; request.end(body.slice(5)); }, 30);
  });
  assert.equal(result, 403); assert.equal(f.calls, 0); await v.close();
});

test('bad URLs, invalid JSON, and unexpected async errors leave the server available without exception leaks', async t => {
  const f = await fixture(t);
  for (const target of ['//', '//[', 'http://[']) {
    const status = await new Promise((resolve, reject) => http.get(f.url, { path: target }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject));
    assert.equal(status, 400); assert.equal((await fetch(f.url + '/api/health')).status, 200);
  }
  assert.equal((await fetch(f.url + '/api/settings/range', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  f.ioService.read = async () => { throw new Error('PRIVATE EXCEPTION ' + testPin); };
  const response = await fetch(f.url + '/api/robots/R_006/io'); assert.equal(response.status, 500);
  const text = await response.text(); assert.ok(!text.includes(testPin)); assert.ok(!text.includes('PRIVATE EXCEPTION'));
  assert.equal((await fetch(f.url + '/api/health')).status, 200);
});
