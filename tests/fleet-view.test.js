'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalize, initialRobot } = require('../lib/normalize');
const entry = { expected_rid: 'R_006', ip: '192.168.20.56', ssh_port: 22 };

function fixture(robots, completed = robots.length) {
  const nodes = new Map();
  const getNode = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, innerHTML: '', textContent: '' }); return nodes.get(id); };
  const context = vm.createContext({ console, setTimeout() {}, clearTimeout() {},
    document: { addEventListener() {}, getElementById: getNode }, robots, completed });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/io.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
  vm.runInContext('state.snapshot={robots,generatedAt:new Date().toISOString(),collector:{initialCompleted:completed}};renderFleet();', context);
  return { nodes, context, run: code => vm.runInContext(code, context) };
}
test('zero SSH successes explains completed failed collection and lets users inspect failed targets', () => {
  const robot = normalize(entry, 0, { ok: false, error: 'timeout' });
  const f = fixture([robot]);
  assert.equal(f.nodes.get('robot-table').innerHTML, '');
  assert.equal(f.nodes.get('empty-state-title').textContent, 'SSH 조회 성공 0대');
  assert.match(f.nodes.get('empty-state-description').textContent, /전체 1대를 조회했지만/);
  assert.equal(f.nodes.get('empty-show-targets').hidden, false);
  f.run('state.includeUnconfirmed=true;renderFleet();');
  const html = f.nodes.get('robot-table').innerHTML;
  assert.match(html, /192\.168\.20\.56/); assert.match(html, /SSH 시간 초과/);
  assert.doesNotMatch(html, /ROS2 실행|실행 중|배터리 잔량 0%/);
  assert.equal(f.nodes.get('include-unconfirmed').checked, true);
  assert.equal(f.nodes.get('visible-count').textContent, 1);
});
test('initial pending targets are distinguished from completed failures and searching works in both views', () => {
  const pending = initialRobot(entry, 0);
  const failed = normalize({ ...entry, expected_rid: 'R_007', ip: '192.168.20.57' }, 1, { ok: false, error: 'no_route' });
  const f = fixture([pending, failed], 1);
  assert.equal(f.nodes.get('empty-state-title').textContent, '첫 조회 진행 중');
  f.run("state.includeUnconfirmed=true;state.search='20.56';renderFleet();");
  assert.match(f.nodes.get('robot-table').innerHTML, /조회 대기/);
  assert.doesNotMatch(f.nodes.get('robot-table').innerHTML, /192\.168\.20\.57/);
});
test('successful-only remains the default and a normal search miss offers filter reset', () => {
  const success = normalize(entry, 0, { ok: true, payload: { process_evidence: [], static_evidence: [] } });
  const failed = normalize({ ...entry, expected_rid: 'R_007', ip: '192.168.20.57' }, 1, { ok: false, error: 'timeout' });
  const f = fixture([success, failed]);
  assert.match(f.nodes.get('robot-table').innerHTML, /192\.168\.20\.56/);
  assert.doesNotMatch(f.nodes.get('robot-table').innerHTML, /192\.168\.20\.57/);
  f.run("state.search='nonexistent';renderFleet();");
  assert.equal(f.nodes.get('empty-state-title').textContent, '조회 결과 없음');
  assert.equal(f.nodes.get('empty-show-targets').hidden, true);
  assert.equal(f.nodes.get('empty-reset').hidden, false);
});
