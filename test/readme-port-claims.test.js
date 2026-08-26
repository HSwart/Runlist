const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README claims match shipped port diagnosis and safe recovery', () => {
  assert.match(readme, /What[\u2019']s Listening lists configured project ports/i);
  assert.match(readme, /confirmation with the exact port and PID/i);
  assert.match(readme, /checks identity again before stopping/i);
  assert.match(readme, /conflict status when a port is blocked/i);
  assert.doesNotMatch(readme, /On a running or conflicted row, shows who owns the port/i);
  assert.doesNotMatch(readme, /auto-kill|kill all|full-system port|Pro tier|free tier|paid/i);
});
