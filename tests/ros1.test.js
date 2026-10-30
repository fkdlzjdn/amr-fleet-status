'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BatteryLive } = require('../lib/battery-live');

test('ROS1 shares the live battery transport and keeps BMS charging/discharging states', t => {
  const collector = new EventEmitter();
  collector.robots = [{ id: 'R_001', ip: '192.168.20.51', activeRos: 'ros1', quality: 'observed', ssh: 'connected', observedAt: new Date().toISOString() }];
  collector.inventory = [{ expected_rid: 'R_001', ip: '192.168.20.51' }];
  let packet, closed = 0;
  const live = new BatteryLive(collector, { openStream: (_robot, onPacket) => { packet = onPacket; return { close() { closed++; } }; } });
  t.after(() => live.close()); const stop = live.watch();
  assert.equal(typeof packet, 'function');
  for (const [code, state] of [[1, 'charging'], [2, 'discharging'], [3, 'idle']]) {
    packet({ payload: { battery: { status: 'observed', percentage: .81, present: true, source: 'ros1', power_supply_status: code, message_age_seconds: .01 } } });
    assert.equal(live.snapshot({ robots: collector.robots }).robots[0].battery.chargingState, state);
  }
  stop(); assert.equal(closed, 1);
});

test('ROS1 transport, IO guards, BMS streaming and fixed systemd control tests use mocks only', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'ros1-runtime-test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
