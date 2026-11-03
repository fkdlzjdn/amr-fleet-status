'use strict';
const crypto = require('node:crypto');
const { openJogStream } = require('./ssh-probe');
const directions = ['forward', 'backward', 'left', 'right', 'stop'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

class JogService {
  constructor(profiles = [], options = {}) {
    this.profiles = profiles.filter(profile => profile.backend !== 'ros1_systemd');
    this.openStream = options.openStream || openJogStream;
    this.now = options.now || Date.now;
    this.sessions = new Map();
    this.timer = setInterval(() => this.expire(), 100); this.timer.unref();
  }
  profile(robot) { return this.profiles.find(p => p.rid === robot.expected_rid && p.ip === robot.ip); }
  publicProfiles() { return this.profiles.map(({ rid, ip }) => ({ id: rid, ip })); }
  open(robot) {
    const profile = this.profile(robot);
    if (!profile) fail(409, '이 로봇의 ROS2 수동 조작 경로가 등록되지 않았습니다.');
    if ([...this.sessions.values()].some(s => s.robot.ip === robot.ip)) fail(409, '다른 수동 JOG 화면이 연결되어 있습니다.');
    if (this.sessions.size >= 2) fail(429, '다른 로봇의 수동 JOG가 연결되어 있습니다.');
    const token = crypto.randomBytes(24).toString('hex');
    const session = { token, robot: { ...robot }, authorizedUntil: 0, expiresAt: this.now() + 1200000,
      linearSpeed: 0.25, angularSpeed: 0.25,
      lastRead: this.now(), lastAt: 0, sequence: -1, state: { status: 'connecting', reason: '로봇 연결 중입니다.' }, handle: null };
    this.sessions.set(token, session);
    try {
      session.handle = this.openStream(robot, { rid: profile.rid, domain: profile.domain }, response => {
        if (!this.sessions.has(token)) return;
        const value = response?.ok ? response.payload?.jog : null;
        session.state = value || { status: 'unavailable', reason: '로봇 연결을 확인하세요.' };
        session.lastAt = this.now();
      }, () => {
        session.state = { status: 'unavailable', reason: '로봇 연결이 종료되었습니다. 화면을 다시 여세요.' };
        session.lastAt = this.now();
        session.handle?.close();
      });
    } catch (error) { this.close(token); throw error; }
    return session;
  }
  get(robot, token) {
    const session = this.sessions.get(token);
    if (!session || session.robot.expected_rid !== robot.expected_rid || session.robot.ip !== robot.ip
      || session.expiresAt <= this.now()) fail(403, '수동 JOG 연결이 만료되었습니다. 화면을 다시 여세요.');
    return session;
  }
  status(session) {
    session.lastRead = this.now();
    const fresh = session.lastAt && this.now() - session.lastAt < 500;
    const failed = session.state.status === 'unavailable';
    return { status: fresh || failed ? session.state.status : 'connecting', reason: fresh || failed ? session.state.reason : '로봇 응답 확인 중입니다.',
      direction: fresh ? session.state.direction || 'stop' : 'stop', linearSpeed: session.linearSpeed, angularSpeed: session.angularSpeed,
      outputLinear: fresh && Number.isFinite(session.state.outputLinear) ? session.state.outputLinear : null,
      outputAngular: fresh && Number.isFinite(session.state.outputAngular) ? session.state.outputAngular : null,
      operatingMode: fresh && ['auto', 'manual'].includes(session.state.operatingMode) ? session.state.operatingMode : 'unknown',
      topic: session.state.topic || null };
  }
  command(session, command) {
    if (!command || typeof command !== 'object' || Object.keys(command).some(k => !['direction', 'sequence', 'linearSpeed', 'angularSpeed', 'immediate'].includes(k))
      || !directions.includes(command.direction) || !Number.isSafeInteger(command.sequence) || command.sequence < 0
      || ['linearSpeed', 'angularSpeed'].some(k => k in command && (!Number.isFinite(command[k]) || command[k] < 0 || command[k] > 1))
      || ('immediate' in command && (typeof command.immediate !== 'boolean' || (command.immediate && command.direction !== 'stop')))) fail(400, 'JOG 방향과 0~1.0 범위의 속도를 입력하세요.');
    if (command.sequence <= session.sequence) fail(409, '지난 JOG 입력입니다. 다시 누르세요.');
    session.sequence = command.sequence;
    if (command.direction !== 'stop' && (this.now() - session.lastAt >= 500 || session.state.status !== 'ready')) {
      session.handle?.send({ direction: 'stop', sequence: command.sequence, immediate: true });
      fail(409, session.state.reason || 'JOG 토픽과 로봇 연결을 확인하세요.');
    }
    const linearSpeed = command.linearSpeed ?? session.linearSpeed, angularSpeed = command.angularSpeed ?? session.angularSpeed;
    if (!session.handle?.send({ ...command, linearSpeed, angularSpeed, challenge: session.state.challenge })) fail(409, '로봇 연결이 종료되었습니다.');
    session.linearSpeed = linearSpeed; session.angularSpeed = angularSpeed;
    return { status: 'accepted', direction: command.direction };
  }
  close(token) {
    const session = this.sessions.get(token);
    if (!session) return;
    this.sessions.delete(token);
    // EOF stops an engaged worker; an untouched panel must not acquire velocity ownership.
    session.handle?.close();
  }
  expire() {
    for (const [token, session] of this.sessions) if (session.expiresAt <= this.now() || this.now() - session.lastRead > 3000) this.close(token);
  }
  prune(inventory) {
    for (const [token, session] of this.sessions) if (!inventory.some(r => r.expected_rid === session.robot.expected_rid && r.ip === session.robot.ip)) this.close(token);
  }
  closeAll() { for (const token of this.sessions.keys()) this.close(token); }
  destroy() { clearInterval(this.timer); this.closeAll(); }
}
module.exports = { JogService };
