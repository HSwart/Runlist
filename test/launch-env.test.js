const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  LaunchEnvError,
  envFileValidationMessage,
  envMapTextValidationMessage,
  mergeLaunchEnvironment,
  normalizeEnvFile,
  normalizeEnvMap,
  parseDotenv,
  parseEnvMapText,
  readProjectEnvFile,
  redactKnownEnvValues,
  resolveEnvFilePath,
  resolveProjectLaunchEnvironment,
  serializeEnvMapText
} = require('../src/projects/launch-env');

test('parses dotenv lines and rejects invalid syntax fail-closed', () => {
  assert.deepEqual(parseDotenv('FOO=bar\n# comment\nexport BAZ="qux"\nEMPTY=\n'), {
    FOO: 'bar',
    BAZ: 'qux',
    EMPTY: ''
  });
  assert.throws(() => parseDotenv('not-a-pair\n'), (error) => (
    error instanceof LaunchEnvError && error.code === 'INVALID_DOTENV'
  ));
  assert.throws(() => parseDotenv('=novalue\n'), (error) => (
    error instanceof LaunchEnvError && error.code === 'INVALID_DOTENV'
  ));
});

test('handles CRLF and quoted values without expanding shell variables', () => {
  assert.deepEqual(parseDotenv('A=1\r\nB="$HOME"\r\nC=\'x=y\'\r\n'), {
    A: '1',
    B: '$HOME',
    C: 'x=y'
  });
});

test('normalizes relative envFile paths and rejects escapes', () => {
  assert.equal(normalizeEnvFile('.env'), '.env');
  assert.equal(normalizeEnvFile('config/.env.local'), 'config/.env.local');
  assert.equal(normalizeEnvFile(''), undefined);
  assert.throws(() => normalizeEnvFile('/abs/.env'), /relative/i);
  assert.throws(() => normalizeEnvFile('../.env'), /inside the project folder/i);
  assert.throws(() => normalizeEnvFile('foo/../../.env'), /inside the project folder/i);
  assert.match(envFileValidationMessage('../secret'), /inside the project folder/i);
  assert.equal(envFileValidationMessage('.env'), undefined);
  assert.equal(envFileValidationMessage(''), undefined);
});

test('resolves envFile inside the project folder only', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', '.env'), 'TOKEN=secret-value\n');

  assert.equal(
    resolveEnvFilePath(root, 'config/.env'),
    path.join(root, 'config', '.env')
  );
  assert.throws(() => resolveEnvFilePath(root, '../outside.env'), /inside the project folder/i);
});

test('reads env file at Start and fails closed when missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=from-file\n');

  assert.deepEqual(readProjectEnvFile(root, '.env'), { API_KEY: 'from-file' });
  assert.throws(
    () => readProjectEnvFile(root, 'missing.env'),
    (error) => error instanceof LaunchEnvError
      && error.code === 'ENV_FILE_MISSING'
      && /missing\.env/i.test(error.message)
      && !/from-file|API_KEY=/.test(error.message)
  );
});

test('normalizes explicit env maps and env text', () => {
  assert.deepEqual(normalizeEnvMap({ FLAG: '1', empty: '' }), { FLAG: '1', empty: '' });
  assert.throws(() => normalizeEnvMap({ '1BAD': 'x' }), /valid/i);
  assert.throws(() => normalizeEnvMap('nope'), /map/i);
  assert.deepEqual(parseEnvMapText('FLAG=1\nNOTE=hello world\n'), {
    FLAG: '1',
    NOTE: 'hello world'
  });
  assert.match(envMapTextValidationMessage('FLAG=1\nbad line') || '', /KEY=value/i);
  assert.equal(envMapTextValidationMessage(''), undefined);
  assert.equal(serializeEnvMapText({ B: '2', A: '1' }), 'A=1\nB=2');
});

test('merges launch env with host < envFile < env map < port overrides', () => {
  const merged = mergeLaunchEnvironment({
    baseEnvironment: { PATH: '/bin', FLAG: 'host', PORT: '1' },
    fileEnvironment: { FLAG: 'file', FILE_ONLY: 'yes', PORT: '2' },
    explicitEnvironment: { FLAG: 'map', MAP_ONLY: 'yes' },
    portOverrides: [{ variable: 'PORT', port: 4310 }]
  });
  assert.equal(merged.PATH, '/bin');
  assert.equal(merged.FLAG, 'map');
  assert.equal(merged.FILE_ONLY, 'yes');
  assert.equal(merged.MAP_ONLY, 'yes');
  assert.equal(merged.PORT, '4310');
});

test('resolveProjectLaunchEnvironment loads file and applies precedence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=file-secret\nFLAG=file\n');

  const environment = resolveProjectLaunchEnvironment({
    folder: root,
    envFile: '.env',
    env: { FLAG: 'map', SAFE: '1' }
  }, { PATH: '/usr/bin', FLAG: 'host' }, [{
    variable: 'APP_PORT',
    port: 3001
  }]);

  assert.equal(environment.TOKEN, 'file-secret');
  assert.equal(environment.FLAG, 'map');
  assert.equal(environment.SAFE, '1');
  assert.equal(environment.APP_PORT, '3001');
  assert.equal(environment.PATH, '/usr/bin');
});

test('redacts known launch env values without dumping keys as secrets alone', () => {
  const text = 'ready TOKEN=file-secret ok and also bare file-secret leftover';
  const redacted = redactKnownEnvValues(text, ['file-secret', '']);
  assert.match(redacted, /\[redacted\]/);
  assert.doesNotMatch(redacted, /file-secret/);
});
