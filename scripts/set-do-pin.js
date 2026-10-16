'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const readline = require('node:readline/promises');

function savePin(root, pin) {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) throw new Error('PIN은 6~12자리 숫자로 입력하세요.');
  const filename = path.join(root, '.env');
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('심볼릭 링크 .env는 직접 관리하세요.');
  const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
  const lines = previous.split(/\r?\n/).filter(line => !/^\s*DO_CONTROL_(?:PIN|PIN_REQUIRED|ENABLED)\s*=/.test(line));
  const content = lines.join('\n').replace(/\n*$/, '') + `\nDO_CONTROL_ENABLED=true\nDO_CONTROL_PIN_REQUIRED=true\nDO_CONTROL_PIN=${pin}\n`;
  const temporary = filename + '.' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
    throw new Error('서버 터미널에서 npm run set-pin으로 실행하세요. PIN을 명령 인자로 전달하지 마세요.');
  }
  // Silence readline's echoed characters and cursor updates; do not print the PIN.
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  output.isTTY = true;
  const input = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write('새 DO 제어 PIN (6~12자리 숫자, 입력 숨김): ');
    const pin = await input.question('');
    process.stdout.write('\nPIN 다시 입력 (입력 숨김): ');
    const confirmation = await input.question('');
    process.stdout.write('\n');
    if (pin !== confirmation) throw new Error('PIN 입력이 일치하지 않습니다. 변경하지 않았습니다.');
    savePin(path.resolve(__dirname, '..'), pin);
    process.stdout.write('PIN 설정 완료. .env 권한 600 적용. 서버를 재시작하고 웹 화면을 새로고침하세요.\n');
  } finally { input.close(); }
}

if (require.main === module) main().catch(error => {
  // Only our fixed validation messages are shown; never log file contents or errors from I/O.
  const allowed = /^(?:PIN은|PIN 입력이|서버 터미널에서|심볼릭 링크)/.test(error.message);
  process.stderr.write((allowed ? error.message : 'PIN 설정을 완료하지 못했습니다. 서버 .env 파일 권한을 확인하세요.') + '\n');
  process.exitCode = 1;
});
module.exports = { savePin };
