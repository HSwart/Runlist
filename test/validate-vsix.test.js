const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { validateVsix } = require('../scripts/validate-vsix');

const root = path.join(__dirname, '..');

test('accepts the reviewed VSIX only when its identity and version match package.json', async () => {
  await assert.doesNotReject(validateVsix(root));
});

test('refuses to publish a stale VSIX', async () => {
  const manifest = require('../package.json');
  const staleVersion = '0.0.0';

  await assert.rejects(
    validateVsix(root, async () => ({ manifest: { ...manifest, version: staleVersion } })),
    (error) => {
      assert.match(error.message, /Refusing to publish a stale or incorrect VSIX/);
      assert.match(error.message, new RegExp(`version is ${staleVersion.replaceAll('.', '\\.')}`));
      assert.match(error.message, new RegExp(`but ${manifest.version.replaceAll('.', '\\.')} in package\\.json`));
      return true;
    }
  );
});
