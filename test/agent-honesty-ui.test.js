const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('agent connections distinguish skill installed from handoff ready', () => {
  assert.match(webview, /Ready for handoff/);
  assert.match(webview, /Skill installed/);
  assert.match(webview, /const handoffReady = connection\.status === 'success'/);
  assert.match(webview, /const skillInstalled = connection\.status === 'installed' \|\| handoffReady/);
  assert.match(webview, /Does not open VS Code chat handoffs/);
});

test('README claims prefilled chat handoff only after Copilot setup', () => {
  assert.match(readme, /after you set up GitHub Copilot/);
  assert.match(readme, /prefilled diagnosis request you can send/);
  assert.doesNotMatch(readme, /with Copilot connected, \*\*Ask your agent\*\* opens/);
});
