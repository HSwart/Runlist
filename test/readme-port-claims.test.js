const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README claims port checks without unsafe kill language', () => {
  assert.match(readme, /Checks configured ports before Start|Checks the port before it starts/);
  assert.match(readme, /Switch cleanly when a port is already in use|helps you switch when another Runlist app owns the port/);
  assert.match(readme, /What\u2019s Listening|What's Listening/);
  assert.doesNotMatch(readme, /auto-kill|kill all|full-system port|Pro tier|free tier|paid/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
