'use strict';
const crypto = require('node:crypto');

class DoControl {
  constructor(env = process.env, options = {}) {
    const pin = env.DO_CONTROL_PIN || '';
    this.pinConfigured = /^\d{6,12}$/.test(pin);
    this.enabled = env.DO_CONTROL_ENABLED === 'true' && this.pinConfigured;
    this.digest = this.enabled ? crypto.createHash('sha256').update(pin).digest() : null;
    this.now = options.now || Date.now;
    this.sessionMs = options.sessionMs ?? 1200000;
    this.windowMs = options.windowMs ?? 60000;
    this.failures = new Map(); this.globalFailures = { at: this.now(), count: 0 };
  }
  status() { return { enabled: this.enabled, pinConfigured: this.pinConfigured }; }
  authorized(session) { return this.enabled && Number.isFinite(session?.authorizedUntil) && session.authorizedUntil > this.now(); }
  lock(session) { session.authorizedUntil = 0; }
  unlock(session, pin, address) {
    if (!this.enabled) return { status: 403, error: 'DO 제어가 비활성화되어 있습니다. 서버 관리자에게 PIN 설정을 요청하세요.' };
    const now = this.now();
    for (const [key, value] of this.failures) if (now - value.at >= this.windowMs) this.failures.delete(key);
    if (now - this.globalFailures.at >= this.windowMs) this.globalFailures = { at: now, count: 0 };
    const previous = this.failures.get(address);
    const blocked = previous?.count >= 5 ? previous : this.globalFailures.count >= 50 ? this.globalFailures : null;
    if (blocked || (!previous && this.failures.size >= 1024)) return {
      status: 429, error: 'PIN 입력 시도가 많습니다. 잠시 후 다시 시도하세요.',
      retryAfter: Math.max(1, Math.ceil((blocked ? this.windowMs - (now - blocked.at) : this.windowMs) / 1000))
    };
    const candidate = typeof pin === 'string' && /^\d{6,12}$/.test(pin)
      ? crypto.createHash('sha256').update(pin).digest() : Buffer.alloc(32);
    if (!crypto.timingSafeEqual(candidate, this.digest)) {
      const failure = previous || { at: now, count: 0 };
      failure.count++; this.failures.set(address, failure); this.globalFailures.count++;
      return { status: 401, error: 'PIN이 일치하지 않습니다.' };
    }
    session.authorizedUntil = now + this.sessionMs;
    return { status: 200, authorized: true, expiresInMs: this.sessionMs };
  }
}

module.exports = { DoControl };
