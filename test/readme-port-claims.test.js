const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README locks signed port claims without the old diagnosis essay', () => {
  assert.match(readme, /Checks the port before it starts/);
  assert.match(readme, /Switch when a port is already in use/);
  assert.doesNotMatch(readme, /## Everyday use/);
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /What[\u2019']s Listening lists configured project ports/i);
  assert.doesNotMatch(readme, /confirmation with the exact port and PID/i);
  assert.doesNotMatch(readme, /checks identity again before stopping/i);
  assert.doesNotMatch(readme, /conflict status when a port is blocked/i);
  assert.doesNotMatch(readme, /On a running or conflicted row, shows who owns the port/i);
  assert.doesNotMatch(readme, /auto-kill|kill all|full-system port|Pro tier|free tier|paid/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
