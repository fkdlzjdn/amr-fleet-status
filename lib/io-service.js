'use strict';
const { probeIo, openIoStream } = require('./ssh-probe');

function normalizeIo(response, now = new Date().toISOString()) {
  const raw = response?.ok ? response.payload?.io : null;
  const statuses = ['observed', 'loading', 'empty', 'node_not_found', 'no_topic', 'identity_unknown', 'ambiguous', 'unsupported',
    'runtime_unavailable', 'timeout', 'stale', 'invalid', 'unavailable'];
  let status = statuses.includes(raw?.status) ? raw.status : response?.error || 'unavailable';
  const result = { status, checkedAt: now, topic: typeof raw?.topic === 'string' ? raw.topic.slice(0, 512) : null,
    node: typeof raw?.node === 'string' ? raw.node.slice(0, 512) : null,
    driverRunning: typeof raw?.driver_running === 'boolean' ? raw.driver_running : null,
    messageAgeSeconds: typeof raw?.message_age_seconds === 'number' && Number.isFinite(raw.message_age_seconds) ? raw.message_age_seconds : null,
    diChannels: [], doChannels: [], invalidCount: 0 };
  if (status !== 'observed') return result;
  if (typeof raw.message_age_seconds !== 'number' || !Number.isFinite(raw.message_age_seconds)
    || raw.message_age_seconds > 10 || raw.message_age_seconds < -5) return { ...result, status: 'stale' };
  if (!Array.isArray(raw.di_channels) || !Array.isArray(raw.do_channels) || raw.di_channels.length > 256 || raw.do_channels.length > 256) return { ...result, status: 'invalid' };
  const seen = new Map();
  const channels = (items, type) => items.map(item => {
    const deviceName = typeof item?.device_name === 'string' ? item.device_name.slice(0, 120) : '';
    const channel = Number.isInteger(item?.channel_id) && item.channel_id >= 0 && item.channel_id <= 65535 ? item.channel_id : null;
    const rawValue = typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null;
    const valid = item?.is_valid === true && deviceName.length > 0 && channel !== null && item.io_type === type && [0, 1].includes(rawValue);
    const entry = { deviceName, channel, type: type === 0 ? 'DI' : 'DO',
      logicalName: typeof item?.logical_name === 'string' ? item.logical_name.slice(0, 120) : '',
      isValid: valid, value: valid ? rawValue : null, state: valid ? rawValue === 1 ? 'on' : 'off' : 'unknown' };
    const key = `${deviceName}:${type}:${channel}`;
    if (seen.has(key)) {
      for (const duplicate of [entry, seen.get(key)]) Object.assign(duplicate, { isValid: false, value: null, state: 'unknown' });
    } else seen.set(key, entry);
    return entry;
  });
  result.diChannels = channels(raw.di_channels, 0);
  result.doChannels = channels(raw.do_channels, 1);
  result.invalidCount = [...result.diChannels, ...result.doChannels].filter(channel => !channel.isValid).length;
  result.status = result.invalidCount ? 'partial' : !result.diChannels.length && !result.doChannels.length ? 'empty' : 'observed';
  return result;
}

class IoService {
  constructor(options = {}) {
    this.probe = options.probe || probeIo;
    this.openStream = options.openStream || openIoStream;
    this.now = options.now || Date.now;
    this.ttl = options.ttl ?? 1500;
    this.maxActive = options.maxActive || 2;
    this.inFlight = new Map(); this.cache = new Map();
    this.streams = new Map();
    this.outputRequests = new Map(); this.outputBusy = new Set();
  }
  key(robot) { return `${robot.expected_rid}:${robot.ip}:${robot.ssh_port}:${(robot.ssh_port_fallbacks || []).join(',')}`; }
  subscribe(robot, listener) {
    const key = this.key(robot);
    let session = this.streams.get(key);
    if (!session) {
      if (this.streams.size + this.inFlight.size >= this.maxActive) {
        listener({ id: robot.expected_rid, ip: robot.ip, ...normalizeIo(), status: 'busy' }, true); return () => {};
      }
      session = { robot, listeners: new Set(), last: null, sequence: 0, lastAt: null, handle: null, closed: false };
      this.streams.set(key, session);
    }
    session.listeners.add(listener);
    if (session.last) listener(session.last, false);
    if (!session.handle) {
      const emit = (value, ended = false) => {
        if (session.closed) return;
        session.last = value;
        for (const callback of [...session.listeners]) callback(value, ended);
      };
      session.handle = this.openStream(robot, response => {
        const now = this.now(), value = { id: robot.expected_rid, ip: robot.ip, ...normalizeIo(response),
          live: true, sequence: ++session.sequence, intervalMs: session.lastAt === null ? null : now - session.lastAt };
        session.lastAt = now; emit(value);
      }, error => {
        const last = session.last;
        const value = last && !['observed', 'partial', 'loading'].includes(last.status) ? last
          : { id: robot.expected_rid, ip: robot.ip, ...normalizeIo({ error }) };
        emit(value, true); session.closed = true; this.streams.delete(key);
      });
    }
    return () => {
      session.listeners.delete(listener);
      if (!session.listeners.size && !session.closed) {
        session.closed = true; this.streams.delete(key); session.handle?.close();
      }
    };
  }
  prune(inventory) {
    const keys = new Set(inventory.map(robot => this.key(robot)));
    for (const [key, session] of this.streams) if (!keys.has(key)) {
      session.closed = true; this.streams.delete(key); session.handle?.close();
      for (const listener of [...session.listeners]) listener({ id: session.robot.expected_rid, ...normalizeIo(), status: 'removed' }, true);
    }
  }
  close() { this.prune([]); }
  async setCharging(robot, command) {
    if (!command || typeof command !== 'object' || Object.keys(command).some(key => !['requestId', 'value', 'expectedValue'].includes(key))) {
      throw Object.assign(new Error('충전 ON/OFF 요청 형식을 확인하세요.'), { status: 400 });
    }
    const current = this.streams.get(this.key(robot))?.last;
    const matching = [...(current?.diChannels || []), ...(current?.doChannels || [])].filter(channel => channel.logicalName === 'charge_relay');
    const channel = matching[0];
    if (matching.length !== 1 || channel?.type !== 'DO' || !channel.isValid) {
      throw Object.assign(new Error('유효한 charge_relay DO를 확인할 수 없어 충전을 제어할 수 없습니다.'), { status: 409 });
    }
    return this.setOutput(robot, { ...command, deviceName: channel.deviceName, channel: channel.channel, logicalName: 'charge_relay' });
  }
  async setOutput(robot, command) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    const fields = ['requestId', 'deviceName', 'channel', 'logicalName', 'value', 'expectedValue'];
    if (!command || typeof command !== 'object' || Object.keys(command).some(key => !fields.includes(key))
      || typeof command.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(command.requestId)
      || typeof command.deviceName !== 'string' || !command.deviceName.length || command.deviceName.length > 120
      || typeof command.logicalName !== 'string' || !command.logicalName.length || command.logicalName.length > 120
      || !Number.isInteger(command.channel) || command.channel < 0 || command.channel > 65535
      || ![0, 1].includes(command.value) || ![0, 1].includes(command.expectedValue)) fail(400, '올바른 DO 채널과 ON/OFF 값이 필요합니다.');
    const key = this.key(robot), requestKey = `${key}:${command.requestId}`;
    const signature = JSON.stringify(fields.slice(1).map(field => command[field]));
    const previous = this.outputRequests.get(requestKey);
    if (previous) {
      if (previous.signature !== signature) fail(409, '같은 요청 ID로 다른 명령을 보낼 수 없습니다.');
      return previous.promise;
    }
    const session = this.streams.get(key), current = session?.last;
    const age = current ? this.now() - Date.parse(current.checkedAt) + Math.max(0, current.messageAgeSeconds || 0) * 1000 : Infinity;
    if (!session || session.closed || !session.handle?.setOutput || !['observed', 'partial'].includes(current?.status)
      || !Number.isFinite(age) || age > 2000) fail(409, '실시간 IO를 수신한 상태에서 DO를 제어하세요.');
    const named = [...current.diChannels, ...current.doChannels].filter(channel => channel.logicalName === command.logicalName);
    const channel = named[0];
    if (named.length !== 1 || !channel?.isValid || channel.type !== 'DO' || channel.deviceName !== command.deviceName
      || channel.channel !== command.channel || channel.value !== command.expectedValue) fail(409, 'DO 채널 또는 현재 값이 변경되었습니다. 다시 확인하세요.');
    if (this.outputBusy.has(key)) fail(409, '이 로봇의 다른 DO 요청이 진행 중입니다.');
    for (const [id, record] of this.outputRequests) if (record.done && this.now() - record.at > 300000) this.outputRequests.delete(id);
    if (this.outputRequests.size >= 512) {
      fail(429, '최근 DO 요청이 많습니다. 잠시 후 다시 요청하세요.');
    }
    this.outputBusy.add(key);
    const record = { signature, done: false, at: this.now(), promise: null };
    record.promise = Promise.resolve().then(() => session.handle.setOutput(command)).then(result => ({
      id: robot.expected_rid, ip: robot.ip, requestId: command.requestId, logicalName: command.logicalName, value: command.value,
      status: result?.status === 'confirmed' && (result.logical_value !== command.value || result.request_id !== command.requestId)
        ? 'unconfirmed' : ['confirmed', 'rejected', 'unconfirmed'].includes(result?.status) ? result.status : 'unconfirmed',
      mayHaveApplied: result?.may_have_applied !== false,
      logicalValue: [0, 1].includes(result?.logical_value) ? result.logical_value : null,
      message: typeof result?.message === 'string' ? result.message.slice(0, 240) : 'DO 결과를 확인하지 못했습니다.'
    })).catch(() => ({ id: robot.expected_rid, requestId: command.requestId, status: 'unconfirmed', mayHaveApplied: true,
      message: 'DO 결과를 확인하지 못했습니다. 요청은 자동 재전송하지 않습니다.' }))
      .finally(() => { record.done = true; this.outputBusy.delete(key); });
    this.outputRequests.set(requestKey, record);
    return record.promise;
  }
  async read(robot) {
    const key = this.key(robot);
    if (this.streams.get(key)?.last) return this.streams.get(key).last;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.time < this.ttl) return cached.value;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const base = { id: robot.expected_rid, ip: robot.ip };
    if (this.inFlight.size + this.streams.size >= this.maxActive) return { ...base, ...normalizeIo(), status: 'busy' };
    const job = Promise.resolve().then(() => this.probe(robot)).then(response => ({ ...base, ...normalizeIo(response) }))
      .catch(() => ({ ...base, ...normalizeIo() })).then(value => {
        if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { time: this.now(), value }); return value;
      }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job); return job;
  }
}

module.exports = { normalizeIo, IoService };
