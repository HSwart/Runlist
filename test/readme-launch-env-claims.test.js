const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'runlist', 'SKILL.md'), 'utf8');

test('Marketplace README locks the signed listing without the launch-env essay', () => {
  assert.match(readme, /Start, stop, and switch local apps from one sidebar\./);
  assert.doesNotMatch(readme, /## Everyday use/);
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /env file/i);
  assert.doesNotMatch(readme, /fails closed if a configured env file is missing/i);
  assert.doesNotMatch(readme, /temporary port variables still win/i);
  assert.doesNotMatch(readme, /redacted from Recent Output/i);
  assert.doesNotMatch(readme, /envFile/);
  assert.doesNotMatch(readme, /\.env\.example/);
  assert.doesNotMatch(readme, /Infisical|Doppler|Vault/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});

test('skill keeps stack contracts free of secret env maps', () => {
  assert.match(skill, /envFile/);
  assert.match(skill, /\.env\.example/);
  assert.match(skill, /must not include secret values or an `env` map/i);
});
