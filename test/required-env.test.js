const assert = require('node:assert/strict');
const test = require('node:test');
const { stripPackageManagerSilentFlags } = require('../src/projects/command-display');
const {
  missingRequiredEnvKeys,
  requiredEnvKeysFromExample
} = require('../src/projects/required-env');

test('strips npm/pnpm/yarn silent flags so stderr remains visible', () => {
  assert.equal(stripPackageManagerSilentFlags('npm run dev --silent'), 'npm run dev');
  assert.equal(stripPackageManagerSilentFlags('pnpm -s start'), 'pnpm start');
  assert.equal(stripPackageManagerSilentFlags('python app.py --silent'), 'python app.py --silent');
});

test('reports required env keys that are missing without exposing values', () => {
  assert.deepEqual(requiredEnvKeysFromExample([
    '# comment',
    'API_KEY=secret-value',
    'DATABASE_URL="postgres://example"',
    '',
    'OPTIONAL='
  ].join('\n')), ['API_KEY', 'DATABASE_URL']);

  assert.deepEqual(missingRequiredEnvKeys(
    ['API_KEY', 'DATABASE_URL'],
    { API_KEY: 'present', EXTRA: 'x' }
  ), ['DATABASE_URL']);
});
