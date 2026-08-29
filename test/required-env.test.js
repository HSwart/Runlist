const assert = require('node:assert/strict');
const test = require('node:test');
const {
  attributeRequiredEmptySources,
  classifyRequiredEnvPresence,
  collectAdvisoryEmptyEnvBySource,
  emptyEnvKeysFromDotenv,
  emptyEnvKeysFromLocalSettings,
  envLocalAttachHint,
  exampleEnvAdvisoryMissing,
  formatEnvPresenceWarnings,
  formatRequiredEnvFailureDetail,
  isMissingRequiredEnvFailure,
  isTestOnlyEnvKey,
  missingRequiredEnvKeys,
  normalizeRequiredEnvKeys,
  resolveExplicitRequiredEnvKeys
} = require('../src/projects/required-env');
const { parseDotenv } = require('../src/projects/launch-env');

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

test('classifies explicit launch-profile required keys as missing or empty', () => {
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
    { API_KEY: 'present', DATABASE_URL: '' }
  ), ['DATABASE_URL']);
  assert.deepEqual(missingRequiredEnvKeys(
    ['API_KEY'],
    { API_KEY: '   ' }
  ), ['API_KEY']);
});

test('classifies required keys as missing or empty', () => {
  assert.deepEqual(classifyRequiredEnvPresence(['A', 'B', 'C'], {
    A: 'ok',
    B: '',
    C: '  '
  }), { missing: [], empty: ['B', 'C'] });
  assert.deepEqual(classifyRequiredEnvPresence(['A', 'B'], { A: 'ok' }), {
    missing: ['B'],
    empty: []
  });
});

test('detects empty dotenv keys including quoted empties', () => {
  const map = parseDotenv('KEY=\nQUOTED=""\nSINGLE=\'\'\nSPACE=   \nPRESENT=value\n');
  assert.deepEqual(emptyEnvKeysFromDotenv(map), ['KEY', 'QUOTED', 'SINGLE', 'SPACE']);
});

test('detects empty local.settings.json Values entries', () => {
  assert.deepEqual(emptyEnvKeysFromLocalSettings({
    Values: {
      AzureWebJobsStorage: '',
      FUNCTIONS_WORKER_RUNTIME: 'python',
      COUNT: 3
    }
  }), ['AzureWebJobsStorage']);
  assert.deepEqual(emptyEnvKeysFromLocalSettings({}), []);
  assert.deepEqual(emptyEnvKeysFromLocalSettings(null), []);
});

test('formats required-env failure detail with missing and empty sources', () => {
  const detail = formatRequiredEnvFailureDetail({
    missing: ['API_KEY'],
    emptyBySource: {
      '.env.local': ['DATABASE_URL'],
      'launch profile env map': ['SECRET']
    }
  });
  assert.match(detail, /Missing: API_KEY/);
  assert.match(detail, /Empty in \.env\.local: DATABASE_URL/);
  assert.match(detail, /Empty in launch profile env map: SECRET/);
});

test('attributes empty required keys to env map or env file', (t) => {
  const root = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'runlist-req-env-'));
  t.after(() => require('node:fs').rmSync(root, { recursive: true, force: true }));
  require('node:fs').writeFileSync(require('node:path').join(root, '.env.local'), 'DATABASE_URL=\n');

  assert.deepEqual(attributeRequiredEmptySources({
    folder: root,
    envFile: '.env.local',
    env: { API_KEY: '' }
  }, ['API_KEY', 'DATABASE_URL']), {
    'launch profile env map': ['API_KEY'],
    '.env.local': ['DATABASE_URL']
  });
});

test('scans project env files for advisory empty keys without repo crawl', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-scan-'));
  const api = path.join(root, 'api');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(api);
  fs.writeFileSync(path.join(api, 'host.json'), '{}');
  fs.writeFileSync(path.join(api, 'local.settings.json'), JSON.stringify({
    Values: { AzureWebJobsStorage: '', FUNCTIONS_WORKER_RUNTIME: 'python' }
  }));
  fs.writeFileSync(path.join(api, '.env.local'), 'UNATTACHED=\n');
  fs.writeFileSync(path.join(api, 'api.env.local'), 'ATTACHED=\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'ROOT_ONLY=\n');

  assert.deepEqual(collectAdvisoryEmptyEnvBySource(api, {
    envFile: 'api.env.local',
    env: { MAP_EMPTY: '' }
  }), {
    'api.env.local': ['ATTACHED'],
    '.env.local': ['UNATTACHED'],
    'launch profile env map': ['MAP_EMPTY'],
    'local.settings.json': ['AzureWebJobsStorage']
  });
  assert.equal(fs.existsSync(path.join(root, '.env.local')), true);
  assert.deepEqual(collectAdvisoryEmptyEnvBySource(api, {}), {
    '.env.local': ['UNATTACHED'],
    'local.settings.json': ['AzureWebJobsStorage']
  });
});

test('advisory warnings include required missing and empty keys by source', () => {
  const warnings = formatEnvPresenceWarnings({
    requiredMissing: ['API_KEY'],
    requiredEmptyBySource: {
      '.env.local': ['DATABASE_URL']
    },
    advisoryEmptyBySource: {
      'local.settings.json': ['AzureWebJobsStorage']
    }
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /Required variables are missing \(Start continues\): API_KEY/);
  assert.match(warnings[1], /Required variables are empty in \.env\.local \(Start continues\): DATABASE_URL/);
  assert.match(warnings[2], /Empty variables in local\.settings\.json/);
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

test('host Start warns on env presence without blocking Start', () => {
  const { readShippedHostSource } = require('./helpers/extension-source');
  const extension = readShippedHostSource();
  assert.match(extension, /resolveExplicitRequiredEnvKeys\(launchProject\)/);
  assert.match(extension, /classifyRequiredEnvPresence/);
  assert.match(extension, /collectAdvisoryEmptyEnvBySource/);
  assert.match(extension, /formatEnvPresenceWarnings/);
  assert.match(extension, /requiredMissing: requiredPresence\.missing/);
  assert.match(extension, /requiredEmptyBySource/);
  assert.match(extension, /for \(const warning of formatEnvPresenceWarnings\(\{[\s\S]*requiredMissing: requiredPresence\.missing/);
  assert.match(extension, /exampleEnvAdvisoryMissing/);
  assert.match(extension, /envLocalAttachHint/);
  assert.doesNotMatch(
    extension,
    /classifyRequiredEnvPresence[\s\S]{0,500}showStartFailure\(project, \{[\s\S]*failureKind: MISSING_REQUIRED_ENV_FAILURE_KIND/
  );
  assert.doesNotMatch(extension, /Missing required environment variables from \.env\.example/);
  assert.doesNotMatch(extension, /requiredEnvKeysFromExample/);
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
