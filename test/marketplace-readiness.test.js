const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  PLACEHOLDER_PUBLISHER,
  validateMarketplace
} = require('../scripts/validate-marketplace');

const root = path.join(__dirname, '..');

test('validates Marketplace metadata while surfacing maintainer-owned release decisions', () => {
  const result = validateMarketplace(root, { preparation: true });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    'choose the permanent Marketplace publisher identifier and replace package.json publisher',
    'assign a new release version and move CHANGELOG.md Unreleased notes before publishing'
  ]);
});

test('blocks publication while the placeholder publisher remains', () => {
  const manifest = require('../package.json');
  const result = validateMarketplace(root);

  assert.equal(manifest.publisher, PLACEHOLDER_PUBLISHER);
  assert.deepEqual(result.errors, [
    'choose the permanent Marketplace publisher identifier and replace package.json publisher',
    'assign a new release version and move CHANGELOG.md Unreleased notes before publishing'
  ]);
});
