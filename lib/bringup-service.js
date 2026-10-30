'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { probeBringup } = require('./ssh-probe');
function loadProfiles(root) {
  const file = path.join(root, 'config/bringup-control.json');
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.robots) || data.robots.length > 256) throw new Error('Invalid bringup profiles');
  const seen = new Set();
  return data.robots.map(profile => {
    const systemd = profile.backend === 'ros1_systemd';
    if (!/^R_\d{3}$/.test(profile.rid) || seen.has(profile.rid)
      || typeof profile.ip !== 'string' || ![undefined, 'ros2_function', 'ros1_systemd'].includes(profile.backend)
      || (systemd ? !/^[a-f0-9]{64}$/.test(profile.unitSha256) || !/^[a-f0-9]{64}$/.test(profile.environmentSha256)
        : !Number.isInteger(profile.domain) || profile.domain < 0 || profile.domain > 232)
      || !Array.isArray(profile.files) || profile.files.length < 1 || profile.files.length > 4
      || profile.files[0].path !== (systemd ? 'scorpion.sh' : '.bash_aliases')
      || profile.files.some(file => typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.split('/').includes('..')
        || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Invalid bringup profile');
    seen.add(profile.rid); return profile;
  });
}
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
class BringupService {
  constructor(profiles = [], options = {}) {
    this.profiles = profiles; this.probe = options.probe || probeBringup; this.now = options.now || Date.now;
    this.reads = new Map(); this.cache = new Map(); this.requests = new Map(); this.busy = new Set(); this.active = 0;
  }
  profile(robot) { return this.profiles.find(profile => profile.rid === robot.expected_rid && profile.ip === robot.ip); }
  publicProfiles() { return this.profiles.map(({ rid, ip }) => ({ id: rid, ip })); }
  key(robot) { return robot.expected_rid + ':' + robot.ip; }
  normalize(response, action) {
    const value = response?.ok ? response.payload?.bringup : null;
    if (!value) return { status: action === 'status' ? 'unavailable' : 'unconfirmed',
      message: action === 'status' ? '로봇의 실행 상태를 확인하지 못했습니다.' : '요청 결과를 확인하지 못했습니다. 자동 재전송하지 않습니다.',
      mayHaveApplied: action !== 'status' && Boolean(response?.sshConnected),
      observed: { state: 'unknown', canStart: false, canStop: false, reason: 'SSH 연결 또는 실행 환경을 확인하세요.' } };
    const raw = value.observed, states = ['running', 'stopped', 'starting', 'stopping', 'ambiguous'];
    const observed = raw && states.includes(raw.state) && /^[a-f0-9]{64}$/.test(raw.revision || '')
      ? { state: raw.state, canStart: raw.canStart === true, canStop: raw.canStop === true,
          reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : '', revision: raw.revision,
          pid: Number.isInteger(raw.process?.pid) ? raw.process.pid : null }
      : { state: 'unknown', canStart: false, canStop: false, reason: '실행 확인 결과가 유효하지 않습니다.' };
    return { status: ['observed', 'confirmed', 'rejected', 'unconfirmed'].includes(value.status) ? value.status : 'unavailable',
      message: typeof value.message === 'string' ? value.message.slice(0, 240) : '', mayHaveApplied: value.mayHaveApplied === true, observed };
  }
  async read(robot) {
    const profile = this.profile(robot); if (!profile) fail(409, '이 로봇의 기동 방식이 등록되지 않았습니다.');
    const key = this.key(robot), cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 1000) return cached.value;
    if (this.reads.has(key)) return this.reads.get(key);
    if (this.active >= 2) fail(429, '다른 bringup 상태를 확인 중입니다. 잠시 후 다시 시도하세요.');
    this.active++;
    const job = Promise.resolve().then(() => this.probe(robot, { action: 'status', profile }))
      .then(response => ({ ...this.normalize(response, 'status'), checkedAt: new Date(this.now()).toISOString() }))
      .finally(() => { this.active--; this.reads.delete(key); });
    this.reads.set(key, job);
    const value = await job; this.cache.set(key, { at: this.now(), value }); return value;
  }
  async run(robot, action, command) {
    const profile = this.profile(robot); if (!profile) fail(409, '이 로봇의 기동 방식이 등록되지 않았습니다.');
    if (!['start', 'stop'].includes(action) || !command || typeof command !== 'object'
      || Object.keys(command).some(key => !['requestId', 'expectedRevision'].includes(key))
      || typeof command.requestId !== 'string' || typeof command.expectedRevision !== 'string'
      || !/^[a-f0-9]{32}$/.test(command.requestId) || !/^[a-f0-9]{64}$/.test(command.expectedRevision)) fail(400, 'bringup 요청 형식을 확인하세요.');
    const key = this.key(robot), requestKey = key + ':' + command.requestId;
    const signature = action + ':' + command.expectedRevision;
    const previous = this.requests.get(requestKey);
    if (previous) { if (previous.signature !== signature) fail(409, '같은 요청 ID로 다른 동작을 보낼 수 없습니다.'); return previous.promise; }
    if (this.busy.has(key)) fail(409, '이 로봇의 bringup 요청을 처리 중입니다.');
    if (this.active >= 2) fail(429, '다른 bringup 요청을 처리 중입니다.');
    for (const [id, request] of this.requests) if (request.done && this.now() - request.at > 300000) this.requests.delete(id);
    if (this.requests.size >= 512) fail(429, '최근 요청이 많습니다. 잠시 후 다시 시도하세요.');
    this.busy.add(key); this.active++;
    const record = { signature, at: this.now(), done: false, promise: null };
    record.promise = Promise.resolve().then(() => this.probe(robot, { action, command, profile }))
      .then(response => ({ ...this.normalize(response, action), checkedAt: new Date(this.now()).toISOString() }))
      .catch(() => ({ status: 'unconfirmed', message: '요청 결과를 확인하지 못했습니다. 자동 재전송하지 않습니다.', mayHaveApplied: true }))
      .finally(() => { record.done = true; this.busy.delete(key); this.active--; this.cache.delete(key); });
    this.requests.set(requestKey, record); return record.promise;
  }
}
module.exports = { BringupService, loadProfiles };
