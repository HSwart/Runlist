const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { validateMarketplace } = require('../scripts/validate-marketplace');

const root = path.join(__dirname, '..');

test('validates Marketplace metadata for the selected publisher and release', () => {
  const manifest = require('../package.json');
  const result = validateMarketplace(root, { preparation: true });

  assert.equal(manifest.name, 'switchboard-projects');
  assert.equal(manifest.publisher, 'hankoswart');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('passes strict Marketplace publication validation', () => {
  const result = validateMarketplace(root);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
