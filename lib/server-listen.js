'use strict';
const os = require('node:os');

function bind(server, options) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options);
  });
}

async function listenServer(server, port) {
  try {
    // Dual stack accepts both localhost (::1) and IPv4, including LAN clients.
    await bind(server, { port, host: '::', ipv6Only: false });
  } catch (error) {
    if (!['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
    await bind(server, { port, host: '0.0.0.0' });
  }
}

function printAddresses(server) {
  const { port } = server.address();
  console.log('AMR Fleet Status LIVE — SSH MONITOR + DO CONTROL');
  console.log(`  같은 PC 접속: http://127.0.0.1:${port}`);
  if (/microsoft/i.test(os.release())) console.log('  Windows 브라우저에서도 위의 127.0.0.1 주소로 접속하세요.');
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|veth|br-)/.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) console.log(`  네트워크 (${name}): http://${entry.address}:${port}`);
    }
  }
  console.log('  종료: Ctrl+C (이 터미널을 켜두세요)');
}

module.exports = { listenServer, printAddresses };
