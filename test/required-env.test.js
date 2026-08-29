const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseDotenv } = require('../src/projects/launch-env');
const {
  classifyRequiredEnvPresence,
  collectAdvisoryEmptyKeysBySource,
  emptyEnvKeysFromDotenv,
  emptyEnvKeysFromLocalSettings,
  envLocalAttachHint,
  exampleEnvAdvisoryMissing,
  formatEnvPresenceWarnings,
  formatRequiredEnvFailureDetail,
  hasRequiredEnvPresenceIssues,
  isEnvValueEmpty,
  isMissingRequiredEnvFailure,
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
  assert.deepEqual(missingRequiredEnvKeys(
    ['API_KEY', 'DATABASE_URL'],
    { API_KEY: '', DATABASE_URL: '   ' }
  ), ['API_KEY', 'DATABASE_URL']);
});

test('treats empty dotenv values as empty and absent keys as missing', () => {
  const map = parseDotenv('PRESENT=value\nEMPTY=\nQUOTED_EMPTY=""\nSINGLE_QUOTED=\'\'\nWHITESPACE=   \n');
  assert.deepEqual(emptyEnvKeysFromDotenv(map), [
    'EMPTY',
    'QUOTED_EMPTY',
    'SINGLE_QUOTED',
    'WHITESPACE'
  ]);
  assert.equal(isEnvValueEmpty(''), true);
  assert.equal(isEnvValueEmpty('   '), true);
  assert.equal(isEnvValueEmpty('value'), false);
});

test('classifies required env presence with missing, empty, and source attribution', () => {
  assert.deepEqual(
    classifyRequiredEnvPresence(
      ['API_KEY', 'DATABASE_URL', 'TOKEN'],
      { API_KEY: 'present', DATABASE_URL: '', TOKEN: '   ' },
      [
        { label: '.env.local', env: { DATABASE_URL: '' } },
        { label: 'launch profile env map', env: { TOKEN: '   ' } }
      ]
    ),
    {
      missing: [],
      emptyBySource: [
        { source: '.env.local', keys: ['DATABASE_URL'] },
        { source: 'launch profile env map', keys: ['TOKEN'] }
      ]
    }
  );
  assert.deepEqual(
    classifyRequiredEnvPresence(['API_KEY'], {}, []),
    { missing: ['API_KEY'], emptyBySource: [] }
  );
  assert.equal(
    hasRequiredEnvPresenceIssues(classifyRequiredEnvPresence(['API_KEY'], { API_KEY: 'ok' }, [])),
    false
  );
  assert.equal(
    hasRequiredEnvPresenceIssues(classifyRequiredEnvPresence(['API_KEY'], { API_KEY: '' }, [
      { label: 'launch profile env map', env: { API_KEY: '' } }
    ])),
    true
  );
});

test('formats required env failure detail with missing and empty sources', () => {
  assert.equal(
    formatRequiredEnvFailureDetail({
      missing: ['API_KEY'],
      emptyBySource: [{ source: '.env.local', keys: ['DATABASE_URL'] }]
    }),
    'Required environment variables are not set for this launch profile. Missing: API_KEY; Empty in .env.local: DATABASE_URL.'
  );
});

test('collects advisory empty keys per source without deduplicating across files', () => {
  assert.deepEqual(
    collectAdvisoryEmptyKeysBySource([
      { label: '.env.local', map: { API_KEY: '', PRESENT: 'ok' } },
      { label: 'api/.env.local', map: { API_KEY: '' } }
    ]),
    [
      { source: '.env.local', keys: ['API_KEY'] },
      { source: 'api/.env.local', keys: ['API_KEY'] }
    ]
  );
});

test('ignores invalid local.settings.json values and non-string entries', () => {
  assert.deepEqual(
    emptyEnvKeysFromLocalSettings({
      Values: {
        AzureWebJobsStorage: '',
        FUNCTIONS_WORKER_RUNTIME: 'node',
        IGNORED_NUMBER: 0,
        IGNORED_OBJECT: {}
      }
    }),
    ['AzureWebJobsStorage']
  );
  assert.deepEqual(emptyEnvKeysFromLocalSettings({}), []);
  assert.deepEqual(emptyEnvKeysFromLocalSettings(null), []);
});

test('warns about advisory empty keys without blocking Start', () => {
  const warnings = formatEnvPresenceWarnings({
    advisoryEmptyBySource: [{ source: '.env.local', keys: ['API_KEY'] }]
  });
  assert.match(warnings[0], /Empty environment variables in \.env\.local/);
  assert.match(warnings[0], /Start continues/);
});

test('scans envFile subpaths relative to the project folder only', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-required-env-'));
  const projectFolder = path.join(root, 'api');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectFolder, { recursive: true });
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(projectFolder, '.env.local'), 'API_KEY=\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'ROOT_ONLY=\n');

  const projectLocal = parseDotenv(fs.readFileSync(path.join(projectFolder, '.env.local'), 'utf8'));
  assert.deepEqual(
    collectAdvisoryEmptyKeysBySource([{ label: '.env.local', map: projectLocal }]),
    [{ source: '.env.local', keys: ['API_KEY'] }]
  );
  assert.equal(fs.existsSync(path.join(root, '.env.local')), true);
  assert.equal(fs.existsSync(path.join(projectFolder, '.env.local')), true);
});

test('identifies missing-required-env failures by kind, not free-text', () => {
  assert.equal(isMissingRequiredEnvFailure({
    failureKind: 'missing-required-env'
  }), true);
  assert.equal(isMissingRequiredEnvFailure({
    kind: 'missing-required-env'
  }), true);
  assert.equal(isMissingRequiredEnvFailure({
    title: 'Start failed',
    message: 'Missing required environment variables for this launch profile: API_KEY.'
  }), false);
  assert.equal(isMissingRequiredEnvFailure({
    kind: 'command-not-found'
  }), false);
  assert.equal(isMissingRequiredEnvFailure(undefined), false);
  assert.equal(isMissingRequiredEnvFailure('missing-required-env'), false);
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

test('host Start never hard-fails on .env.example alone or nested PowerShell lint', () => {
  const { readShippedHostSource } = require('./helpers/extension-source');
  const extension = readShippedHostSource();
  assert.match(extension, /resolveExplicitRequiredEnvKeys\(launchProject\)/);
  assert.match(extension, /exampleEnvAdvisoryMissing/);
  assert.match(extension, /envLocalAttachHint/);
  assert.match(extension, /formatEnvPresenceWarnings/);
  assert.match(extension, /classifyRequiredEnvPresence/);
  assert.match(extension, /formatRequiredEnvFailureDetail/);
  assert.match(extension, /collectAdvisoryEmptyKeysBySource/);
  assert.match(
    extension,
    /showStartFailure\(project, \{[\s\S]*failureKind: MISSING_REQUIRED_ENV_FAILURE_KIND/
  );
  assert.doesNotMatch(extension, /Missing required environment variables from \.env\.example/);
  assert.doesNotMatch(extension, /requiredEnvKeysFromExample/);
  assert.doesNotMatch(extension, /missingRequiredEnvKeys/);
  // Nested PowerShell is advisory only — must not showStartFailure / return false.
  assert.match(extension, /windowsStartCommandIssues\(launchProject\.startCommand/);
  assert.doesNotMatch(
    extension,
    /windowsStartCommandIssues[\s\S]{0,400}showStartFailure/
  );
  assert.match(
    extension,
    /verificationOnly[\s\S]{0,200}liveChild/
  );
});
