'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Collector } = require('./lib/collector');
const { credentials } = require('./lib/ssh-probe');
const { listenServer, printAddresses } = require('./lib/server-listen');
const { IoService } = require('./lib/io-service');
const { BatteryLive } = require('./lib/battery-live');
const { DoControl } = require('./lib/do-control');
const { loadEnv, inventoryFile, DEFAULT_RANGE, validateRange, loadRange, saveRange, inventoryForRange } = require('./lib/config');
const root = __dirname;
loadEnv(path.join(root, '.env'));
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/io.js': ['io.js', 'text/javascript; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
function json(response, status, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data));
}
function createApplication(collector, options = {}) {
  const ioService = options.ioService || new IoService();
  const batteryLive = options.batteryLive || new BatteryLive(collector);
  const doControl = options.doControl || new DoControl();
  const snapshot = () => batteryLive.snapshot(collector.snapshot());
  const rangePath = options.rangePath || path.join(root, 'runtime/scan-range.json');
  const defaults = options.inventory || inventoryFile(root);
  const clients = new Set(), ioClients = new Set(), ioControlTokens = new Map(); let scheduled = null;
  const broadcast = () => {
    scheduled = null;
    const current = snapshot(); const message = `id: ${current.sequence}\nevent: fleet\ndata: ${JSON.stringify(current)}\n\n`;
    for (const response of clients) {
      if (response.writableLength > 1024 * 1024) { clients.delete(response); response.end(); }
      else response.write(message);
    }
  };
  collector.on('change', () => { if (!scheduled) scheduled = setTimeout(broadcast, 400); });
  batteryLive.on('battery', value => {
    const message = `event: battery\ndata: ${JSON.stringify(value)}\n\n`;
    for (const response of [...clients]) {
      if (response.writableLength > 256 * 1024) { clients.delete(response); response.end(); }
      else response.write(message);
    }
  });
  const heartbeat = setInterval(() => { for (const response of clients) response.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
  const handleRequest = async (request, response) => {
    response.on('error', () => response.destroy());
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    let url;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) return json(response, 400, { error: '올바른 요청 경로가 아닙니다.' });
      url = new URL(request.url, 'http://localhost');
    } catch { return json(response, 400, { error: '올바른 요청 경로가 아닙니다.' }); }
    if (request.method === 'POST' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: 'Origin not allowed' });
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { status: 'ok', mode: 'live', version: '0.3.0', readOnly: !doControl.enabled, ioOutputControl: doControl.enabled, collector: collector.snapshot().collector });
    if (request.method === 'GET' && url.pathname === '/api/fleet') return json(response, 200, snapshot());
    if (request.method === 'GET' && url.pathname === '/api/collector/status') return json(response, 200, collector.snapshot().collector);
    if (request.method === 'GET' && /^\/api\/robots\/(?:R_\d{3}|IP_[0-9_]+)\/io\/events$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const robot = collector.inventory.find(item => item.expected_rid === id);
      if (!robot) return json(response, 404, { error: '등록된 로봇이 아닙니다.' });
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write('retry: 1000\n\n'); ioClients.add(response);
      const controlToken = crypto.randomBytes(24).toString('hex');
      const controlSession = { id, ip: robot.ip, authorizedUntil: 0 }; ioControlTokens.set(controlToken, controlSession);
      let unsubscribe, closed = false;
      const dispose = () => { if (closed) return; closed = true; clearInterval(beat); ioClients.delete(response); ioControlTokens.delete(controlToken); unsubscribe?.(); };
      const beat = setInterval(() => { if (!closed) response.write(': heartbeat\n\n'); }, 5000); beat.unref();
      response.on('close', dispose);
      unsubscribe = ioService.subscribe(robot, (value, ended) => {
        if (closed || response.destroyed || response.writableEnded) { dispose(); return; }
        if (response.writableLength > 256 * 1024 || !collector.inventory.some(item => item.expected_rid === id && item.ip === robot.ip)) {
          dispose(); return response.end();
        }
        response.write(`event: io\ndata: ${JSON.stringify({ ...value, controlToken, controlEnabled: doControl.enabled,
          controlPinRequired: doControl.pinRequired,
          controlAuthorized: doControl.authorized(controlSession) })}\n\n`);
        if (ended) { dispose(); response.end(); }
      });
      if (closed) unsubscribe();
      return;
    }
    if (request.method === 'POST' && /^\/api\/robots\/(?:R_\d{3}|IP_[0-9_]+)\/io\/(?:unlock|lock|output|charge)$/.test(url.pathname)) {
      const action = url.pathname.split('/').at(-1);
      const id = url.pathname.split('/')[3], robot = collector.inventory.find(item => item.expected_rid === id);
      if (!robot) return json(response, 404, { error: '등록된 로봇이 아닙니다.' });
      if (request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: '같은 화면에서 DO 제어를 요청하세요.' });
      const token = ioControlTokens.get(request.headers['x-io-control-token']);
      if (!token || token.id !== id || token.ip !== robot.ip) return json(response, 403, { error: '열려 있는 실시간 IO 화면이 필요합니다.' });
      if (action === 'lock') { doControl.lock(token); return json(response, 200, { authorized: doControl.authorized(token) }); }
      if (!doControl.enabled) return json(response, 403, { error: 'DO 제어가 비활성화되어 있습니다. 서버 관리자에게 활성화를 요청하세요.' });
      if (['output', 'charge'].includes(action) && !doControl.authorized(token)) return json(response, 403, { error: 'DO 제어 PIN 인증이 필요합니다.', pinRequired: true });
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'JSON 형식으로 입력하세요.' });
      let body = '';
      try {
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024) return json(response, 413, { error: '요청이 너무 큽니다.' }); }
        const command = JSON.parse(body);
        if (ioControlTokens.get(request.headers['x-io-control-token']) !== token) return json(response, 403, { error: 'IO 연결이 종료되었습니다. 다시 연결하세요.' });
        if (!collector.inventory.some(item => item.expected_rid === id && item.ip === robot.ip)) return json(response, 409, { error: '조회 범위가 변경되었습니다.' });
        if (action === 'unlock') {
          const result = doControl.unlock(token, command?.pin, request.socket.remoteAddress || 'unknown');
          if (result.retryAfter) response.setHeader('Retry-After', result.retryAfter);
          return json(response, result.status, result);
        }
        if (!doControl.authorized(token)) return json(response, 403, { error: 'DO 제어 PIN 인증이 만료되었습니다.', pinRequired: true });
        const result = await (action === 'charge' ? ioService.setCharging(robot, command) : ioService.setOutput(robot, command));
        return json(response, result.status === 'rejected' ? 409 : result.status === 'unconfirmed' ? 202 : 200, result);
      } catch (error) {
        return json(response, error instanceof SyntaxError ? 400 : error.status || 500,
          { error: error instanceof SyntaxError ? '올바른 JSON을 입력하세요.' : error.status ? error.message : 'DO 요청 결과를 확인하지 못했습니다.' });
      }
    }
    if (request.method === 'GET' && /^\/api\/robots\/(?:R_\d{3}|IP_[0-9_]+)\/io$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const robot = collector.inventory.find(item => item.expected_rid === id);
      if (!robot) return json(response, 404, { error: '등록된 로봇이 아닙니다.' });
      const value = await ioService.read(robot);
      if (!collector.inventory.some(item => item.expected_rid === id && item.ip === robot.ip)) return json(response, 404, { error: '조회 범위가 변경되었습니다.' });
      return json(response, 200, value);
    }
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      const auth = credentials();
      return json(response, 200, { mode: 'live', readOnly: !doControl.enabled, ioOutputControl: doControl.enabled, doControl: doControl.status(), range: collector.range || validateRange(DEFAULT_RANGE), defaultRange: DEFAULT_RANGE, maxTargets: 256, username: auth.username,
        keyConfigured: Boolean(auth.privateKey), passwordConfigured: Boolean(auth.password), knownHostsConfigured: Boolean(auth.knownHosts),
        intervalMs: collector.interval, concurrency: collector.concurrency, total: collector.inventory.length });
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/range') {
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'JSON 형식으로 입력하세요.' });
      let body = '', input;
      try {
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 2048) return json(response, 413, { error: '요청이 너무 큽니다.' });
        }
        input = validateRange(JSON.parse(body));
      } catch (error) { return json(response, 400, { error: error instanceof SyntaxError ? '올바른 JSON을 입력하세요.' : error.message }); }
      const inventory = inventoryForRange(input, defaults);
      try { saveRange(rangePath, input); }
      catch { return json(response, 500, { error: 'IP 범위를 저장하지 못했습니다. 서버 저장 경로를 확인하세요.' }); }
      collector.reconfigure(inventory, input);
      ioService.prune?.(inventory);
      return json(response, 200, { range: input, snapshot: snapshot() });
    }
    if (request.method === 'POST' && (url.pathname === '/api/fleet/refresh' || /^\/api\/robots\/(?:R_\d{3}|IP_[0-9_]+)\/refresh$/.test(url.pathname))) {
      const id = url.pathname.startsWith('/api/robots/') ? url.pathname.split('/')[3] : undefined;
      if (id && !collector.inventory.some(item => item.expected_rid === id)) return json(response, 404, { error: '등록된 로봇이 아닙니다.' });
      collector.refresh(id); return json(response, 202, { accepted: true, mode: 'live', readOnly: true, collector: collector.snapshot().collector });
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`retry: 1000\nevent: fleet\ndata: ${JSON.stringify(snapshot())}\n\n`); clients.add(response);
      const unwatch = batteryLive.watch();
      response.on('close', () => { clients.delete(response); unwatch(); }); return;
    }
    if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '지원하지 않는 API입니다.' });
    const asset = assets[url.pathname];
    if (request.method !== 'GET' || !asset) { response.writeHead(404); return response.end('Not found'); }
    fs.readFile(path.join(root, 'public', asset[0]), (error, data) => { if (error) { response.writeHead(500); return response.end('Asset unavailable'); }
      response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' }); response.end(data); });
  };
  const server = http.createServer((request, response) => {
    Promise.resolve().then(() => handleRequest(request, response)).catch(() => {
      // Never return raw exceptions or request bodies (which may contain a PIN).
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) return response.destroy();
      json(response, 500, { error: '요청을 처리하지 못했습니다. 다시 시도하세요.' });
    });
  });
  server.on('close', () => { clearInterval(heartbeat); clearTimeout(scheduled); ioService.close?.(); batteryLive.close(); });
  server.closeClients = () => {
    for (const response of clients) response.end(); clients.clear();
    for (const response of ioClients) response.end(); ioClients.clear(); ioService.close?.(); batteryLive.close();
  };
  return server;
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3100);
  const interval = Number(process.env.FLEET_INTERVAL_MS || 30000), concurrency = Number(process.env.FLEET_CONCURRENCY || 5);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(interval) || interval < 15000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('Invalid server/collector settings');
  const range = loadRange(path.join(root, 'runtime/scan-range.json'));
  const collector = new Collector(inventoryForRange(range, inventoryFile(root)), { interval, concurrency, range });
  const server = createApplication(collector);
  listenServer(server, port).then(() => {
    printAddresses(server);
    collector.start();
  }).catch(error => {
    console.error(error.code === 'EADDRINUSE'
      ? `포트 ${port}이 이미 사용 중입니다. 기존 서버를 종료하거나 PORT=${port + 1} npm start 로 실행하세요.`
      : `서버 시작 실패 (${error.code || 'ERROR'}): ${error.message}`);
    collector.stop(); server.closeClients(); server.close(); process.exitCode = 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { collector.stop(); server.closeClients(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
}
module.exports = { createApplication };
