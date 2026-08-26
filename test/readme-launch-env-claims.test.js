const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'runlist', 'SKILL.md'), 'utf8');

test('README launch env claims match shipped fail-closed and redaction behavior', () => {
  assert.match(readme, /env file/i);
  assert.match(readme, /fails closed if a configured env file is missing/i);
  assert.match(readme, /temporary port variables still win/i);
  assert.match(readme, /redacted from Recent Output/i);
  assert.match(readme, /envFile/);
  assert.match(readme, /\.env\.example/);
  assert.doesNotMatch(readme, /Infisical|Doppler|Vault/i);
});

test('skill keeps stack contracts free of secret env maps', () => {
  assert.match(skill, /envFile/);
  assert.match(skill, /\.env\.example/);
  assert.match(skill, /must not include secret values or an `env` map/i);
});
