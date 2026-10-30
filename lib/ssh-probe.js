'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('ssh2');
const { hostKeys, verifyHost, hostAlgorithms } = require('./known-hosts');
const script = fs.readFileSync(path.join(__dirname, 'robot-probe.py'), 'utf8');
const ros1Runtime = fs.readFileSync(path.join(__dirname, 'ros1-runtime.py'), 'utf8');
const batteryScript = ros1Runtime + '\n' + fs.readFileSync(path.join(__dirname, 'battery-probe.py'), 'utf8');
const batteryLiveScript = batteryScript + '\n' + fs.readFileSync(path.join(__dirname, 'battery-stream.py'), 'utf8');
const ioScript = ros1Runtime + '\n' + fs.readFileSync(path.join(__dirname, 'io-probe.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'io-output.py'), 'utf8');
const bringupScript = fs.readFileSync(path.join(__dirname, 'bringup-worker.py'), 'utf8');
const bringupRemoteCommand = `python3 -B -c 'import base64;exec(compile(base64.b64decode("${Buffer.from(bringupScript).toString('base64')}"),"<amr_fleet_bringup_control>","exec"))'`;
// Fixed commands. HTTP never supplies executable code. DO writes use a validated stream message.
const remoteCommand = `python3 -B -c 'import base64;BATTERY_WORKER_SOURCE=base64.b64decode("${Buffer.from(batteryScript).toString('base64')}").decode();exec(compile(BATTERY_WORKER_SOURCE,"<amr_fleet_battery_read>","exec"));exec(compile(base64.b64decode("${Buffer.from(script).toString('base64')}"),"<amr_fleet_readonly_probe>","exec"))'`;
const ioRemoteCommand = `python3 -B -c 'import base64;PROBE_MODE="io";BATTERY_WORKER_SOURCE=base64.b64decode("${Buffer.from(batteryScript).toString('base64')}").decode();exec(compile(BATTERY_WORKER_SOURCE,"<amr_fleet_battery_read>","exec"));IO_WORKER_SOURCE=base64.b64decode("${Buffer.from(ioScript).toString('base64')}").decode();exec(compile(IO_WORKER_SOURCE,"<amr_fleet_io_read>","exec"));exec(compile(base64.b64decode("${Buffer.from(script).toString('base64')}"),"<amr_fleet_readonly_probe>","exec"))'`;
const ioStreamCommand = ioRemoteCommand.replace('PROBE_MODE="io"', 'PROBE_MODE="io_stream"');
const batteryStreamCommand = `python3 -B -c 'import base64;PROBE_MODE="battery_stream";BATTERY_WORKER_SOURCE=base64.b64decode("${Buffer.from(batteryLiveScript).toString('base64')}").decode();exec(compile(BATTERY_WORKER_SOURCE,"<amr_fleet_battery_live>","exec"));exec(compile(base64.b64decode("${Buffer.from(script).toString('base64')}"),"<amr_fleet_readonly_probe>","exec"))'`;
const safeRead = filename => { try { return fs.readFileSync(filename); } catch { return null; } };
function credentials(env = process.env) {
  const keyPath = env.FLEET_SSH_KEY || path.join(os.homedir(), '.ssh/id_rsa');
  const knownPath = env.FLEET_KNOWN_HOSTS || path.join(os.homedir(), '.ssh/known_hosts');
  return { username: env.FLEET_SSH_USER || 'syscon', privateKey: safeRead(keyPath), password: env.FLEET_SSH_PASSWORD || undefined,
    passphrase: env.FLEET_SSH_KEY_PASSPHRASE || undefined, knownHosts: safeRead(knownPath)?.toString() || '' };
}
function classifyError(error, hostFailure, connected) {
  if (hostFailure) return hostFailure;
  if (error.level === 'client-authentication') return 'auth_failed';
  if (error.code === 'ECONNREFUSED') return 'connection_refused';
  if (['EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) return 'no_route';
  if (error.code === 'PROBE_OUTPUT_INVALID') return 'probe_failed';
  if (error.code === 'PROBE_TIMEOUT') return 'probe_timeout';
  if (error.level === 'client-timeout' || error.code === 'ETIMEDOUT') return 'timeout';
  return connected ? 'probe_failed' : 'connection_error';
}
function probePort(robot, port, config, options = {}) {
  return new Promise(resolve => {
    const conn = new (options.ClientCtor || Client)();
    const records = hostKeys(config.knownHosts, robot.ip, port);
    let done = false, connected = false, reached = false, hostFailure, fingerprint;
    const finish = value => { if (done) return; done = true; clearTimeout(deadline); conn.end(); resolve({ ...value, port, reached: Boolean(value.reached || value.ok || reached), sshConnected: connected, fingerprint }); };
    const deadline = setTimeout(() => finish({ ok: false, error: connected ? 'probe_timeout' : 'timeout' }), options.totalTimeout || 11000);
    conn.on('ready', () => {
      connected = true; reached = true;
      conn.exec(options.mode === 'bringup' ? bringupRemoteCommand : options.mode === 'io' ? ioRemoteCommand : remoteCommand, { pty: false }, (error, stream) => {
        if (error) return finish({ ok: false, error: 'probe_failed' });
        let stdout = '', stderr = '';
        stream.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 128 * 1024) { stream.close(); finish({ ok: false, error: 'probe_output_limit' }); } });
        stream.stderr.on('data', chunk => { if (stderr.length < 1024) stderr += chunk.toString(); });
        stream.on('error', () => finish({ ok: false, error: 'probe_failed' }));
        stream.on('close', code => {
          if (done) return;
          if (code !== 0) return finish({ ok: false, error: /python3.*(?:not found|command not found)/.test(stderr) ? 'python_unavailable' : 'probe_failed' });
          try {
            const payload = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1));
            if (payload.schema_version !== 1 || (options.mode === 'bringup' ? !payload.bringup || typeof payload.bringup.status !== 'string'
              : !Array.isArray(payload.process_evidence) || !Array.isArray(payload.static_evidence))) throw new Error('Invalid schema');
            finish({ ok: true, payload });
          } catch { finish({ ok: false, error: 'probe_failed' }); }
        });
        if (options.mode === 'bringup') stream.end(JSON.stringify(options.bringupRequest));
      });
    });
    conn.on('error', error => finish({ ok: false, error: classifyError(error, hostFailure, connected), reached: reached || error.code === 'ECONNREFUSED' }));
    conn.on('close', () => { if (!done) finish({ ok: false, error: connected ? 'probe_failed' : 'connection_error' }); });
    const authHandler = [];
    if (config.privateKey) authHandler.push('publickey');
    if (config.password) authHandler.push('password');
    const connect = { host: robot.ip, port, username: config.username, readyTimeout: options.readyTimeout || 3500,
      hostVerifier: key => { reached = true; fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        if (!records.length) { hostFailure = 'host_key_unknown'; return false; }
        if (!verifyHost(records, key)) { hostFailure = 'host_key_mismatch'; return false; }
        return true;
      }, authHandler, ...(config.privateKey ? { privateKey: config.privateKey, passphrase: config.passphrase } : {}), ...(config.password ? { password: config.password } : {}) };
    if (records.length) connect.algorithms = { serverHostKey: hostAlgorithms(records) };
    try { conn.connect(connect); } catch { finish({ ok: false, error: 'credentials_invalid' }); }
  });
}
async function probeRobot(robot, config = credentials(), options = {}) {
  const ports = [...new Set([robot.ssh_port, ...(robot.ssh_port_fallbacks || [])])];
  const attempts = [];
  for (const port of ports) {
    const result = await probePort(robot, port, config, options); attempts.push({ port, error: result.error || null });
    if (result.ok || result.sshConnected || ['auth_failed', 'host_key_unknown', 'host_key_mismatch', 'credentials_invalid'].includes(result.error)) return { ...result, attempts };
  }
  return { ok: false, port: ports[0], reached: attempts.some(a => a.error === 'connection_refused'), sshConnected: false, error: attempts.at(-1)?.error || 'unknown', attempts };
}
const probeIo = (robot, config, options = {}) => probeRobot(robot, config, { ...options, mode: 'io' });
const probeBringup = (robot, request, config = credentials(), options = {}) => probeRobot(robot, config, {
  ...options, mode: 'bringup', bringupRequest: request, totalTimeout: 22000
});
function openIoStream(robot, onPacket, onEnd, config = credentials(), options = {}) {
  const batteryMode = options.streamKind === 'battery';
  const ports = [...new Set([robot.ssh_port, ...(robot.ssh_port_fallbacks || [])])];
  let stopped = false, finished = false, connection, channel, startup, watchdog, ping, portIndex = 0;
  const pendingOutputs = new Map();
  const clearTimers = () => { clearTimeout(startup); clearTimeout(watchdog); clearInterval(ping); };
  const release = () => {
    for (const [requestId, pending] of pendingOutputs) {
      clearTimeout(pending.timer); pending.resolve({ request_id: requestId, status: 'unconfirmed', may_have_applied: true, message: 'Connection closed; request was not retried' });
    }
    pendingOutputs.clear();
    clearTimers(); channel?.end();
    const current = connection;
    setTimeout(() => current?.end(), 300).unref();
  };
  const finish = error => {
    if (stopped || finished) return;
    finished = true; release(); onEnd(error || 'connection_error');
  };
  const connect = () => {
    const conn = new (options.ClientCtor || Client)(), port = ports[portIndex++], records = hostKeys(config.knownHosts, robot.ip, port);
    connection = conn;
    let connected = false, hostFailure, failed = false, buffer = '';
    const fail = error => {
      if (failed || stopped || finished || connection !== conn) return;
      failed = true;
      const reason = typeof error === 'string' ? error : classifyError(error, hostFailure, connected);
      if (!connected && portIndex < ports.length && ['connection_refused', 'no_route', 'timeout', 'connection_error'].includes(reason)) {
        clearTimers(); conn.end(); connect();
      } else finish(reason);
    };
    startup = setTimeout(() => fail(connected ? 'probe_timeout' : 'timeout'), options.startupTimeout || 9000);
    conn.on('ready', () => {
      if (stopped || finished || failed || connection !== conn) return conn.end();
      connected = true;
      conn.exec(batteryMode ? batteryStreamCommand : ioStreamCommand, { pty: false }, (error, stream) => {
        if (error) return fail('probe_failed');
        if (stopped || finished || failed || connection !== conn) { stream.end(); return conn.end(); }
        channel = stream;
        stream.on('error', () => fail('probe_failed'));
        stream.on('close', () => fail('connection_error'));
        stream.stderr.on('data', () => {});
        const lease = () => { if (!stream.destroyed && stream.writable) stream.write('\n'); };
        lease(); ping = setInterval(lease, 2000); ping.unref();
        stream.on('data', chunk => {
          if (stopped || finished || failed) return;
          buffer += chunk.toString();
          if (buffer.length > 128 * 1024) return fail('probe_output_limit');
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (!line) continue;
            let packet;
            try {
              packet = JSON.parse(line);
              if (!batteryMode && packet.schema_version === 1 && packet.control && typeof packet.control.request_id === 'string') {
                const pending = pendingOutputs.get(packet.control.request_id);
                if (pending) { clearTimeout(pending.timer); pendingOutputs.delete(packet.control.request_id); pending.resolve(packet.control); }
                continue;
              }
              const value = batteryMode ? packet.battery : packet.io;
              if (packet.schema_version !== 1 || !value || typeof value.status !== 'string') throw new Error('schema');
            } catch { return fail('probe_failed'); }
            clearTimeout(startup); clearTimeout(watchdog);
            watchdog = setTimeout(() => fail('probe_timeout'), options.silenceTimeout || 3000);
            onPacket({ ok: true, payload: batteryMode ? { battery: packet.battery } : { io: packet.io } });
            if (stopped || finished) return;
          }
        });
      });
    });
    conn.on('error', fail);
    conn.on('close', () => fail('connection_error'));
    const authHandler = [];
    if (config.privateKey) authHandler.push('publickey');
    if (config.password) authHandler.push('password');
    const settings = { host: robot.ip, port, username: config.username, readyTimeout: options.readyTimeout || 3500,
      keepaliveInterval: 2000, keepaliveCountMax: 2,
      hostVerifier: key => {
        if (!records.length) { hostFailure = 'host_key_unknown'; return false; }
        if (!verifyHost(records, key)) { hostFailure = 'host_key_mismatch'; return false; }
        return true;
      }, authHandler, ...(config.privateKey ? { privateKey: config.privateKey, passphrase: config.passphrase } : {}),
      ...(config.password ? { password: config.password } : {}) };
    if (records.length) settings.algorithms = { serverHostKey: hostAlgorithms(records) };
    try { conn.connect(settings); } catch { fail('credentials_invalid'); }
  };
  connect();
  const close = () => { if (stopped) return; stopped = true; release(); };
  if (batteryMode) return { close };
  return {
    setOutput(command) {
      if (stopped || finished || !channel?.writable || channel.destroyed) return Promise.resolve({ status: 'rejected', may_have_applied: false, message: 'IO stream is not connected' });
      if (pendingOutputs.size) return Promise.resolve({ status: 'rejected', may_have_applied: false, message: 'Another DO request is pending' });
      return new Promise(resolve => {
        const requestId = command.requestId;
        const timer = setTimeout(() => {
          pendingOutputs.delete(requestId); resolve({ request_id: requestId, status: 'unconfirmed', may_have_applied: true, message: 'DO result timeout; request was not retried' });
        }, 5500);
        pendingOutputs.set(requestId, { resolve, timer });
        channel.write(JSON.stringify({ type: 'set_output', requestId, deviceName: command.deviceName, channel: command.channel,
          logicalName: command.logicalName, value: command.value, expectedValue: command.expectedValue }) + '\n');
      });
    },
    close
  };
}
const openBatteryStream = (robot, onPacket, onEnd, config, options = {}) => openIoStream(robot, onPacket, onEnd, config, { ...options, streamKind: 'battery' });
module.exports = { probeRobot, probeIo, probeBringup, openIoStream, openBatteryStream, credentials, classifyError, remoteCommand, ioRemoteCommand, ioStreamCommand, batteryStreamCommand, bringupRemoteCommand };
