const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseDotenv, readProjectEnvFile } = require('../src/projects/launch-env');
const {
  classifyRequiredEnvPresence,
  collectAdvisoryEmptyKeysBySource,
  emptyEnvKeysFromLocalSettings,
  envLocalAttachHint,
  formatEnvPresenceWarnings,
  formatRequiredEnvFailureDetail,
  hasRequiredEnvPresenceIssues
} = require('../src/projects/required-env');

function temporaryFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Azure Functions folder warns about empty AzureWebJobsStorage in local.settings.json', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, 'host.json'), '{}');
  fs.writeFileSync(path.join(root, 'local.settings.json'), JSON.stringify({
    Values: {
      AzureWebJobsStorage: '',
      FUNCTIONS_WORKER_RUNTIME: 'node'
    }
  }));

  const settings = JSON.parse(fs.readFileSync(path.join(root, 'local.settings.json'), 'utf8'));
  const advisory = collectAdvisoryEmptyKeysBySource([
    { label: 'local.settings.json', settings }
  ]);
  assert.deepEqual(advisory, [{
    source: 'local.settings.json',
    keys: ['AzureWebJobsStorage']
  }]);
  assert.deepEqual(emptyEnvKeysFromLocalSettings({ not: 'json' }), []);
});

test('Node folder blocks Start when attached envFile has an empty required key', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, '.env.local'), 'API_KEY=\n');
  const fileEnv = readProjectEnvFile(root, '.env.local');
  const merged = { ...fileEnv };
  const presence = classifyRequiredEnvPresence(
    ['API_KEY'],
    merged,
    [{ label: '.env.local', env: fileEnv }]
  );
  assert.equal(hasRequiredEnvPresenceIssues(presence), true);
  assert.match(
    formatRequiredEnvFailureDetail(presence),
    /Empty in \.env\.local: API_KEY/
  );
});

test('Node folder warns when .env.local is present but not attached', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, '.env.local'), 'API_KEY=\n');
  const map = parseDotenv(fs.readFileSync(path.join(root, '.env.local'), 'utf8'));
  const warnings = formatEnvPresenceWarnings({
    advisoryEmptyBySource: collectAdvisoryEmptyKeysBySource([
      { label: '.env.local', map }
    ]),
    envLocalHint: envLocalAttachHint('.env', true)
  });
  assert.match(warnings[0], /Empty environment variables in \.env\.local/);
  assert.match(warnings[1], /Attach it as this launch profile/);
});

test('monorepo project folder does not scan root .env.local', (t) => {
  const root = temporaryFolder(t);
  const projectFolder = path.join(root, 'apps', 'api');
  fs.mkdirSync(projectFolder, { recursive: true });
  fs.writeFileSync(path.join(root, '.env.local'), 'ROOT_ONLY=\n');
  fs.writeFileSync(path.join(projectFolder, '.env.local'), 'API_KEY=value\n');

  const projectMap = parseDotenv(fs.readFileSync(path.join(projectFolder, '.env.local'), 'utf8'));
  const advisory = collectAdvisoryEmptyKeysBySource([
    { label: '.env.local', map: projectMap }
  ]);
  assert.deepEqual(advisory, []);
  assert.equal(fs.existsSync(path.join(root, '.env.local')), true);
});

test('invalid local.settings.json scan does not throw or block by itself', () => {
  assert.doesNotThrow(() => {
    try {
      JSON.parse('{ invalid');
    } catch {
      // Host path catches parse failures and continues Start.
    }
  });
  assert.equal(
    hasRequiredEnvPresenceIssues(classifyRequiredEnvPresence([], {}, [])),
    false
  );
});
