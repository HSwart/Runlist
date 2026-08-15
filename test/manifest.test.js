const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('ships as a local UI extension with a Marketplace icon', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.deepEqual(manifest.extensionKind, ['ui']);
  assert.equal(manifest.icon, 'media/switchboard.png');
  assert.equal(fs.existsSync(path.join(root, manifest.icon)), true);
});
