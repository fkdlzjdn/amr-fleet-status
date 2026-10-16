'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { probeRobot, credentials } = require('./ssh-probe');
const { initialRobot, normalize, normalizeBattery, summarize } = require('./normalize');
class Collector extends EventEmitter {
  constructor(inventory, options = {}) {
    super(); this.inventory = inventory; this.options = options; this.probe = options.probe || probeRobot;
    this.interval = options.interval || 30000; this.concurrency = options.concurrency || 5;
    this.statePath = options.statePath || path.join(__dirname, '../runtime/fleet-state.json');
    this.robots = inventory.map(initialRobot); this.queue = []; this.pending = new Set(); this.active = new Set(); this.activeIps = new Set();
    this.generation = 0; this.range = options.range || null; this.historyCache = new Map();
    this.completed = new Set(); this.nextDue = new Map(); this.sequence = 0; this.running = false;
    this.startedAt = null; this.lastUpdate = null; this.timer = null; this.failures = new Map();
    try {
      const stored = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.historyCache = new Map((stored.robots || []).map(robot => [robot.ip, robot]));
      this.robots.forEach(robot => { const old = stored.robots?.find(item => item.id === robot.id && item.ip === robot.ip);
        if (old) { robot.previous = old.ssh === 'connected' ? { model: old.model, modelLabel: old.modelLabel, configuredRos: old.configuredRos, distro: old.distro, observedRid: old.observedRid, observedAt: old.observedAt, battery: old.battery } : old.previous || null; robot.history = (old.history || []).slice(0, 30); }
      });
    } catch { /* first launch or unavailable history */ }
  }
  start() {
    if (this.running) return; this.running = true; this.startedAt = new Date().toISOString();
    // R_006 is the user-confirmed live reference; the remaining inventory follows.
    this.refresh('R_006'); this.refresh();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const robot of this.robots) if ((this.nextDue.get(robot.id) || 0) <= now) this.enqueue(robot.id);
      this.pump();
    }, 1000); this.timer.unref();
  }
  enqueue(id) {
    if (!this.running || this.pending.has(id) || this.active.has(`${this.generation}:${id}`)) return false;
    this.queue.push(id); this.pending.add(id); return true;
  }
  refresh(id) {
    if (id) { if (!this.inventory.some(robot => robot.expected_rid === id)) return false; this.enqueue(id); }
    else for (const entry of this.inventory) this.enqueue(entry.expected_rid);
    this.pump(); return true;
  }
  pump() {
    while (this.running && this.active.size < this.concurrency && this.queue.length) {
      const next = this.queue.findIndex(id => !this.activeIps.has(this.inventory.find(entry => entry.expected_rid === id)?.ip));
      if (next < 0) break;
      const [id] = this.queue.splice(next, 1), ip = this.inventory.find(entry => entry.expected_rid === id).ip;
      this.activeIps.add(ip); this.pending.delete(id); const generation = this.generation, token = `${generation}:${id}`; this.active.add(token);
      this.collect(id, generation).finally(() => { this.active.delete(token); this.activeIps.delete(ip); this.pump(); this.changed(); });
    }
  }
  async collect(id, generation = this.generation) {
    const index = this.inventory.findIndex(item => item.expected_rid === id), entry = this.inventory[index];
    let response;
    try { response = await this.probe(entry, credentials(), this.options.probeOptions); }
    catch { response = { ok: false, error: 'connection_error' }; }
    if (!this.running || generation !== this.generation) return;
    const previous = this.robots[index];
    const robot = normalize(entry, index, response, previous);
    const signature = value => JSON.stringify([value.reachability, value.ssh, value.model, value.configuredRos, value.activeRos, value.distro, value.observedRid, value.service, value.bringup, value.details.errorCode]);
    const history = [...(previous.history || [])];
    if (signature(robot) !== signature(previous)) history.unshift({ time: robot.checkedAt,
      title: response.ok ? '실제 상태 조회 완료' : '접속 / 조회 상태 변경', detail: robot.issues[0] || `${robot.modelLabel} · ${robot.configuredRos.toUpperCase()} · scorpion ${robot.service}` });
    robot.history = history.filter(event => Date.now() - new Date(event.time).getTime() < 30 * 86400000).slice(0, 30);
    this.robots[index] = robot; this.completed.add(id); this.lastUpdate = robot.checkedAt;
    const failures = response.ok ? 0 : (this.failures.get(id) || 0) + 1; this.failures.set(id, failures);
    this.nextDue.set(id, Date.now() + (failures > 1 ? Math.min(this.interval * 2, 60000) : this.interval));
    this.persist(); this.changed();
  }
  reconfigure(inventory, range) {
    const current = new Map(this.robots.map(robot => [robot.ip, robot]));
    for (const robot of this.robots) this.historyCache.set(robot.ip, robot);
    this.generation++; this.inventory = inventory; this.range = range;
    this.queue = []; this.pending.clear(); this.completed.clear(); this.nextDue.clear(); this.failures.clear();
    this.robots = inventory.map((entry, index) => {
      const old = current.get(entry.ip);
      if (old) return { ...old, number: index + 1 };
      const robot = initialRobot(entry, index), cached = this.historyCache.get(entry.ip);
      if (cached) {
        robot.history = cached.history || [];
        robot.previous = cached.observedAt ? { model: cached.model, configuredRos: cached.configuredRos, observedAt: cached.observedAt, battery: cached.battery } : cached.previous;
      }
      return robot;
    });
    this.persist(); this.refresh(); this.changed();
  }
  changed() { this.sequence++; this.emit('change'); }
  persist() {
    try { fs.mkdirSync(path.dirname(this.statePath), { recursive: true }); for (const robot of this.robots) this.historyCache.set(robot.ip, robot); fs.writeFileSync(this.statePath + '.tmp', JSON.stringify({ robots: [...this.historyCache.values()].slice(-1024) }), { mode: 0o600 }); fs.renameSync(this.statePath + '.tmp', this.statePath); }
    catch { this.persistenceError = true; }
  }
  snapshot() {
    const now = Date.now();
    const robots = this.robots.map(robot => {
      if (robot.observedAt && now - new Date(robot.observedAt).getTime() > 90000 && robot.ssh === 'connected') return {
        ...initialRobot(this.inventory.find(item => item.expected_rid === robot.id), robot.number - 1), history: robot.history,
        quality: 'stale', battery: normalizeBattery({ status: 'stale' }), checkedAt: robot.checkedAt, previous: { model: robot.model, modelLabel: robot.modelLabel, configuredRos: robot.configuredRos, observedAt: robot.observedAt, battery: robot.battery },
        evidence: '이전 확인값 · 현재 관측 유효 시간 초과', issues: ['현재 정보를 갱신하지 못했습니다.'], needsAttention: true
      };
      return robot;
    });
    return { schemaVersion: '1.2', mode: 'live', range: this.range, sequence: this.sequence, generatedAt: this.lastUpdate || this.startedAt,
      collector: { connected: this.running, label: 'SSH 읽기 전용 수집', active: this.active.size, queued: this.queue.length,
        initialCompleted: this.completed.size, total: this.robots.length, intervalMs: this.interval, concurrency: this.concurrency,
        startedAt: this.startedAt, lastUpdate: this.lastUpdate, persistenceError: Boolean(this.persistenceError) }, summary: summarize(robots), robots };
  }
  stop() { this.running = false; clearInterval(this.timer); }
}
module.exports = { Collector };
