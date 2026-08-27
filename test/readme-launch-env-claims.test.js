const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README claims optional env file without secrets-manager parity', () => {
  assert.match(readme, /Optional env file/);
  assert.match(readme, /launch profile/);
  assert.match(readme, /keep secrets in the file/i);
  assert.doesNotMatch(readme, /Infisical|Doppler|Vault/i);
  assert.doesNotMatch(readme, /envFile/);
  assert.doesNotMatch(readme, /\.env\.example/);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
