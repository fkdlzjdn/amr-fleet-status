'use strict';
const crypto = require('node:crypto');
function matchesHost(pattern, host) {
  if (!pattern.startsWith('|1|')) return pattern === host;
  const parts = pattern.split('|');
  if (parts.length !== 4) return false;
  const hash = crypto.createHmac('sha1', Buffer.from(parts[2], 'base64')).update(host).digest('base64');
  return hash === parts[3];
}
function hostKeys(text, ip, port) {
  const host = port === 22 ? ip : `[${ip}]:${port}`;
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const revoked = parts[0] === '@revoked';
    if (revoked) parts.shift();
    if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('@')) continue;
    if (parts[0].split(',').some(pattern => matchesHost(pattern, host))) records.push({ type: parts[1], key: Buffer.from(parts[2], 'base64'), revoked });
  }
  return records;
}
function verifyHost(records, key) {
  const matches = records.filter(record => record.key.length === key.length && crypto.timingSafeEqual(record.key, key));
  return matches.some(record => !record.revoked) && !matches.some(record => record.revoked);
}
function hostAlgorithms(records) {
  return [...new Set(records.flatMap(record => record.type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [record.type]))];
}
module.exports = { hostKeys, verifyHost, hostAlgorithms };
