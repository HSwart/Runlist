const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { archiveContentMismatches, validateVsix } = require('../scripts/validate-vsix');

const root = path.join(__dirname, '..');

test('accepts the reviewed VSIX only when identity, version, and contents match', async () => {
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

test('detects changed shipped files even when the manifest identity still matches', () => {
  const reviewed = new Map([
    ['extension/package.json', Buffer.from('{"version":"0.0.8"}')],
    ['extension/src/projects/project-tags.js', Buffer.from('old implementation')]
  ]);
  const candidate = new Map([
    ['extension/package.json', Buffer.from('{"version":"0.0.8"}')],
    ['extension/src/projects/project-tags.js', Buffer.from('current implementation')]
  ]);

  assert.deepEqual(archiveContentMismatches(reviewed, candidate), [
    'extension/src/projects/project-tags.js differs'
  ]);
});

test('does not treat platform line endings as changed shipped content', () => {
  assert.deepEqual(archiveContentMismatches(
    new Map([['extension/extension.js', Buffer.from('const value = 1;\n')]]),
    new Map([['extension/extension.js', Buffer.from('const value = 1;\r\n')]])
  ), []);
});
