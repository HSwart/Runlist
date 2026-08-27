const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README claims Load stack without auto-start or secrets in-file', () => {
  assert.match(readme, /Load stack/);
  assert.match(readme, /review it/i);
  assert.doesNotMatch(readme, /runlist\.json/);
  assert.doesNotMatch(readme, /\.runlist\/projects\.json/);
  assert.doesNotMatch(readme, /envFile/);
  assert.doesNotMatch(readme, /auto-?apply|auto-?start.*stack|starts? on clone/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
