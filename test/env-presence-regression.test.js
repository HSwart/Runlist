const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectAdvisoryEmptyEnvBySource,
  emptyEnvKeysFromLocalSettings
} = require('../src/projects/required-env');

test('lists the same empty key under each source file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-dup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env.local'), 'SHARED=\n');
  fs.writeFileSync(path.join(root, 'api.env.local'), 'SHARED=\n');

  assert.deepEqual(collectAdvisoryEmptyEnvBySource(root, {
    envFile: 'api.env.local'
  }), {
    'api.env.local': ['SHARED'],
    '.env.local': ['SHARED']
  });
});

test('ignores invalid local.settings.json without throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-bad-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'host.json'), '{}');
  fs.writeFileSync(path.join(root, 'local.settings.json'), '{ invalid');

  assert.doesNotThrow(() => collectAdvisoryEmptyEnvBySource(root, {}));
  assert.deepEqual(collectAdvisoryEmptyEnvBySource(root, {}), {});
});

test('ignores unreadable dotenv files without throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-bad-dotenv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env.local'), 'BAD\nNOT_A_PAIR\n');

  assert.doesNotThrow(() => collectAdvisoryEmptyEnvBySource(root, {}));
  assert.deepEqual(collectAdvisoryEmptyEnvBySource(root, {}), {});
});

test('ignores non-string Values entries in local.settings.json', () => {
  assert.deepEqual(emptyEnvKeysFromLocalSettings({
    Values: {
      COUNT: 0,
      ENABLED: true,
      EMPTY: ''
    }
  }), ['EMPTY']);
});
