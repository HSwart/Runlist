const assert = require('node:assert/strict');
const test = require('node:test');
const {
  envLocalAttachHint,
  exampleEnvAdvisoryMissing,
  isTestOnlyEnvKey,
  missingRequiredEnvKeys,
  normalizeRequiredEnvKeys,
  resolveExplicitRequiredEnvKeys
} = require('../src/projects/required-env');

test('does not treat .env.example keys as required blockers', () => {
  const missing = exampleEnvAdvisoryMissing([
    'API_KEY=secret-value',
    'PLAYWRIGHT_BASE_URL=http://localhost:3000',
    'PLAYWRIGHT_BROWSERS_PATH=0',
    'DATABASE_URL="postgres://example"',
    'OPTIONAL='
  ].join('\n'), { API_KEY: 'present' });

  assert.deepEqual(missing.requiredMissing, []);
  assert.ok(missing.advisoryMissing.includes('PLAYWRIGHT_BASE_URL'));
  assert.ok(missing.advisoryMissing.includes('PLAYWRIGHT_BROWSERS_PATH'));
  assert.ok(missing.advisoryMissing.includes('DATABASE_URL'));
  assert.equal(missing.advisoryMissing.includes('API_KEY'), false);
  assert.equal(missing.advisoryMissing.includes('OPTIONAL'), false);
});

test('only explicit launch-profile required keys can block Start', () => {
  assert.deepEqual(normalizeRequiredEnvKeys([' API_KEY ', 'DATABASE_URL', 'API_KEY']), [
    'API_KEY',
    'DATABASE_URL'
  ]);
  assert.equal(normalizeRequiredEnvKeys(undefined), undefined);
  assert.throws(() => normalizeRequiredEnvKeys(['bad-key']), /valid environment variable/);

  assert.deepEqual(resolveExplicitRequiredEnvKeys({
    requiredEnvKeys: ['API_KEY', 'PLAYWRIGHT_BASE_URL']
  }), ['API_KEY', 'PLAYWRIGHT_BASE_URL']);
  assert.deepEqual(resolveExplicitRequiredEnvKeys({}), []);
  assert.deepEqual(missingRequiredEnvKeys(
    ['API_KEY', 'DATABASE_URL'],
    { API_KEY: 'present', EXTRA: 'x' }
  ), ['DATABASE_URL']);
});

test('classifies Playwright and other test-only keys for advisory wording', () => {
  assert.equal(isTestOnlyEnvKey('PLAYWRIGHT_BASE_URL'), true);
  assert.equal(isTestOnlyEnvKey('CYPRESS_BASE_URL'), true);
  assert.equal(isTestOnlyEnvKey('DATABASE_URL'), false);
});

test('suggests attaching reviewed .env.local when present and unused', () => {
  assert.match(
    envLocalAttachHint('.env', true),
    /\.env\.local/
  );
  assert.equal(envLocalAttachHint('.env.local', true), undefined);
  assert.equal(envLocalAttachHint(undefined, false), undefined);
});

test('host Start never hard-fails on .env.example alone', () => {
  const { readShippedHostSource } = require('./helpers/extension-source');
  const extension = readShippedHostSource();
  assert.match(extension, /resolveExplicitRequiredEnvKeys\(launchProject\)/);
  assert.match(extension, /exampleEnvAdvisoryMissing/);
  assert.match(extension, /envLocalAttachHint/);
  assert.match(extension, /formatEnvPresenceWarnings/);
  assert.doesNotMatch(extension, /Missing required environment variables from \.env\.example/);
  assert.doesNotMatch(extension, /requiredEnvKeysFromExample/);
});
