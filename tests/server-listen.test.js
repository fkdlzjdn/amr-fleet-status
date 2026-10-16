'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { listenServer } = require('../lib/server-listen');

test('one listener serves the UI over IPv4 and IPv6 loopback', async t => {
  const server = http.createServer((_request, response) => response.end('ready'));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await listenServer(server, 0);
  const { port, family } = server.address();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready');
  if (family === 'IPv6') assert.equal(await (await fetch(`http://[::1]:${port}`)).text(), 'ready');
});

test('IPv4-only systems fall back, but port conflicts fail without switching listeners', async () => {
  for (const code of ['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL', 'EADDRINUSE']) {
    const server = new EventEmitter(), calls = [];
    server.listen = options => {
      calls.push(options);
      queueMicrotask(() => calls.length === 1
        ? server.emit('error', Object.assign(new Error(code), { code }))
        : server.emit('listening'));
    };
    if (code === 'EADDRINUSE') {
      await assert.rejects(listenServer(server, 3100), { code });
      assert.equal(calls.length, 1);
    } else {
      await listenServer(server, 3100);
      assert.deepEqual(calls[1], { port: 3100, host: '0.0.0.0' });
    }
    assert.equal(server.listenerCount('error'), 0);
    assert.equal(server.listenerCount('listening'), 0);
  }
});
