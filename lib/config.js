'use strict';
const fs = require('node:fs');
const path = require('node:path');
function loadEnv(filename, env = process.env) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(PORT|FLEET_SSH_USER|FLEET_SSH_KEY|FLEET_SSH_PASSWORD|FLEET_SSH_KEY_PASSPHRASE|FLEET_KNOWN_HOSTS|FLEET_INTERVAL_MS|FLEET_CONCURRENCY|DO_CONTROL_ENABLED|DO_CONTROL_PIN_REQUIRED|DO_CONTROL_PIN)\s*=\s*(.*)$/);
    if (!match || env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
}
function inventoryFile(root) {
  const configured = path.join(root, 'config/fleet.json');
  const data = JSON.parse(fs.readFileSync(fs.existsSync(configured) ? configured : path.join(root, 'config/fleet.inventory.example.json'), 'utf8'));
  const robots = data.robots;
  if (!Array.isArray(robots) || robots.length !== 50) throw new Error('Fleet inventory must contain 50 robots');
  const ids = new Set(), ips = new Set();
  for (const robot of robots) {
    if (!/^R_\d{3}$/.test(robot.expected_rid) || ids.has(robot.expected_rid)) throw new Error('Invalid or duplicate RID');
    if (!/^192\.168\.20\.(?:5[1-9]|[6-9][0-9]|100)$/.test(robot.ip) || ips.has(robot.ip)) throw new Error('IP must be in the configured 51–100 fleet');
    for (const port of [robot.ssh_port, ...(robot.ssh_port_fallbacks || [])]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
    ids.add(robot.expected_rid); ips.add(robot.ip);
  }
  return robots;
}
const DEFAULT_RANGE = Object.freeze({ startIp: '192.168.20.51', endIp: '192.168.20.100' });
function ipv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) throw new Error('올바른 IPv4 주소를 입력하세요.');
  const parts = value.split('.').map(Number);
  if (parts.some(n => n > 255)) throw new Error('IPv4 각 자리는 0–255여야 합니다.');
  if (!(parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168)) throw new Error('로봇 LAN의 사설 IPv4 범위를 입력하세요.');
  return parts.reduce((sum, n) => sum * 256 + n, 0);
}
function validateRange(input) {
  const startIp = input?.startIp, endIp = input?.endIp;
  const start = ipv4(startIp), end = ipv4(endIp), total = end - start + 1;
  if (total < 1) throw new Error('끝 IP는 시작 IP보다 크거나 같아야 합니다.');
  if (total > 256) throw new Error('한 번에 최대 256개 IP까지 조회할 수 있습니다.');
  return { startIp, endIp, total };
}
function loadRange(filename) {
  return validateRange(fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : DEFAULT_RANGE);
}
function saveRange(filename, range) {
  const valid = validateRange(range);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename + '.tmp', JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(filename + '.tmp', filename);
  return valid;
}
function inventoryForRange(input, defaults) {
  const range = validateRange(input), start = ipv4(range.startIp);
  return Array.from({ length: range.total }, (_, index) => {
    const number = start + index;
    const ip = [24, 16, 8, 0].map(bits => Math.floor(number / 2 ** bits) % 256).join('.');
    const configured = defaults.find(entry => entry.ip === ip);
    if (configured) return { ...configured };
    return { expected_rid: 'IP_' + ip.replaceAll('.', '_'), ip, ssh_port: 22, ssh_port_fallbacks: [2222], credential_profile: 'syscon-fleet', expected_model: null, enabled: true };
  });
}
module.exports = { loadEnv, inventoryFile, DEFAULT_RANGE, validateRange, loadRange, saveRange, inventoryForRange };
