'use strict';
const { EventEmitter } = require('node:events');
const { openBatteryStream } = require('./ssh-probe');
const { normalizeBattery } = require('./normalize');

class BatteryLive extends EventEmitter {
  constructor(collector, options = {}) {
    super(); this.collector = collector; this.openStream = options.openStream || openBatteryStream;
    this.now = options.now || Date.now; this.maxActive = options.maxActive ?? 256;
    this.sessions = new Map(); this.watchers = 0; this.timer = null;
    this.onCollectorChange = () => { if (this.watchers) this.reconcile(); };
    collector.on('change', this.onCollectorChange);
  }
  key(robot) { return `${robot.id || robot.expected_rid}:${robot.ip}`; }
  watch() {
    this.watchers++;
    if (this.watchers === 1) {
      this.reconcile(); this.timer = setInterval(() => { this.reconcile(); this.expire(); }, 500); this.timer.unref();
    }
    let closed = false;
    return () => { if (closed) return; closed = true; this.watchers = Math.max(0, this.watchers - 1); if (!this.watchers) this.stop(); };
  }
  reconcile() {
    if (!this.watchers) return;
    const eligible = new Map(this.collector.robots.filter(robot => robot.ssh === 'connected' && ['ros1', 'ros2'].includes(robot.activeRos)
      && ['observed', 'partial'].includes(robot.quality) && this.now() - Date.parse(robot.observedAt) <= 90000)
      .map(robot => [this.key(robot), robot]));
    for (const [key, session] of this.sessions) if (!eligible.has(key)) this.remove(key, session);
    for (const [key, robot] of eligible) {
      if (this.sessions.has(key) || this.sessions.size >= this.maxActive) continue;
      const entry = this.collector.inventory.find(item => item.expected_rid === robot.id && item.ip === robot.ip);
      if (!entry) continue;
      const session = { key, entry, closed: false, handle: null, retry: null, failures: 0, battery: null, at: null, lastDataAt: null };
      this.sessions.set(key, session); this.connect(session);
    }
  }
  publish(session) {
    if (session.closed || !this.watchers) return;
    this.emit('battery', { id: session.entry.expected_rid, ip: session.entry.ip, battery: session.battery });
  }
  connect(session) {
    if (session.closed || !this.watchers) return;
    const end = error => {
      if (session.closed) return;
      session.handle = null;
      if (session.lastDataAt !== null) {
        session.battery = { ...normalizeBattery(), live: false, liveStatus: 'reconnecting' }; this.publish(session);
      }
      session.failures++;
      const delay = ['auth_failed', 'host_key_unknown', 'host_key_mismatch', 'credentials_invalid'].includes(error)
        ? 30000 : Math.min(1000 * 2 ** Math.min(session.failures - 1, 5), 30000);
      session.retry = setTimeout(() => this.connect(session), delay); session.retry.unref();
    };
    try {
      session.handle = this.openStream(session.entry, response => {
        if (session.closed || !this.watchers) return;
        const raw = response.payload?.battery;
        if (raw?.status === 'loading') return;
        const battery = normalizeBattery(raw, new Date(this.now()).toISOString());
        const live = ['observed', 'invalid'].includes(battery.status);
        session.at = this.now(); session.lastDataAt = session.at;
        if (live) session.failures = 0;
        session.battery = { ...battery, live, liveStatus: live ? 'live' : 'unavailable' };
        this.publish(session);
      }, end);
    } catch { end('unavailable'); }
  }
  expire() {
    for (const session of this.sessions.values()) if (session.battery?.live
      && this.now() - session.at + Math.max(0, session.battery.messageAgeSeconds || 0) * 1000 > 2000) {
      session.battery = { ...normalizeBattery({ status: 'stale' }), live: false, liveStatus: 'stale' }; this.publish(session);
    }
  }
  snapshot(snapshot) {
    this.expire();
    return { ...snapshot, batteryLive: { active: this.sessions.size, watching: this.watchers > 0, supportedRos: 'ros1,ros2' },
      robots: snapshot.robots.map(robot => {
        const session = this.sessions.get(this.key(robot));
        if (!session || robot.ssh !== 'connected' || !['observed', 'partial'].includes(robot.quality)) return robot;
        return { ...robot, battery: session.battery || { ...robot.battery, live: false, liveStatus: session.failures ? 'reconnecting' : 'connecting' } };
      }) };
  }
  remove(key, session) {
    session.closed = true; clearTimeout(session.retry); session.handle?.close(); this.sessions.delete(key);
  }
  stop() { clearInterval(this.timer); this.timer = null; for (const [key, session] of this.sessions) this.remove(key, session); }
  close() { this.watchers = 0; this.stop(); this.collector.removeListener('change', this.onCollectorChange); }
}

module.exports = { BatteryLive };
