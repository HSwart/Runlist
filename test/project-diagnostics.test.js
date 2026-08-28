const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_DIAGNOSTIC_OUTPUT_CHARS,
  boundedDiagnosticOutput,
  clearProjectDiagnostics,
  diagnosticsPath,
  readProjectDiagnostics,
  redactSensitiveText,
  writeProjectDiagnostics
} = require('../src/projects/project-diagnostics');
const { readShippedHostSource } = require('./helpers/extension-source');

test('sanitizes terminal controls and redacts credential-like diagnostic text', () => {
  const clean = boundedDiagnosticOutput([
    '\u001b[31mStart failed\u001b[0m',
    'API_KEY=super-secret',
    'NODE_ENV=production',
    'Authorization: Bearer abc.def.ghi',
    'postgres://user:password@example.test/database',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'npm run dev -- --token cli-secret',
    'https://example.test/?access_token=query-secret&safe=value',
    'npm_config_//registry.example/:_authToken=npm-secret'
  ].join('\n')).output;

  assert.match(clean, /Start failed/);
  assert.doesNotMatch(clean, /\u001b|super-secret|production|abc\.def\.ghi|password|ghp_|cli-secret|query-secret|npm-secret|safe=value/);
  assert.match(clean, /API_KEY=\[redacted\]/);
  assert.match(clean, /Authorization: \[redacted\]/);
  assert.match(clean, /user:\[redacted\]@example\.test/);
});

test('redacts structured credential aliases without removing ordinary context', () => {
  const clean = redactSensitiveText([
    '{"context":{"access_token":"access-secret"},"items":[{"api_token":"api-secret"}]}',
    '{"aws_secret_access_key":"aws-secret","refreshToken":"refresh-secret"}',
    'access_token: colon-secret',
    'api_token=equals-secret',
    'message=keep-this-context'
  ].join('\n'));

  assert.doesNotMatch(
    clean,
    /access-secret|api-secret|aws-secret|refresh-secret|colon-secret|equals-secret/
  );
  assert.match(clean, /keep-this-context/);
  assert.match(clean, /"access_token":\s*"?\[redacted\]/);
  assert.match(clean, /"api_token":\s*"?\[redacted\]/);
  assert.match(clean, /"aws_secret_access_key":\s*"?\[redacted\]/);
  assert.match(clean, /"refreshToken":\s*"?\[redacted\]/);
  assert.match(clean, /access_token:\s*\[redacted\]/);
  assert.match(clean, /api_token=\[redacted\]/);
});

test('bounds diagnostics without splitting UTF-16 surrogate pairs', () => {
  const bounded = boundedDiagnosticOutput(`old${'x'.repeat(MAX_DIAGNOSTIC_OUTPUT_CHARS)}😀tail`);

  assert.equal(bounded.truncated, true);
  assert.ok(bounded.output.length <= MAX_DIAGNOSTIC_OUTPUT_CHARS);
  assert.doesNotMatch(bounded.output, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.match(bounded.output, /😀tail$/);
});

test('stores one hashed, bounded failure record for the exact project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-diagnostics-'));
  const projectsFile = path.join(root, 'projects.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const projectId = '../another-project';
  const record = writeProjectDiagnostics(projectsFile, projectId, {
    platform: 'darwin',
    lifecycleState: 'stopped',
    exitCode: 1,
    summary: { message: 'TOKEN: secret-value' },
    output: '',
    launchProfileId: 'tests',
    failedAt: 42
  });

  assert.equal(record.retainedOutput, '');
  assert.equal(record.failureSummary.message, 'TOKEN: [redacted]');
  assert.equal(record.launchProfileId, 'tests');
  assert.equal(path.dirname(diagnosticsPath(projectsFile, projectId)), path.join(root, 'failed-start-diagnostics'));
  assert.deepEqual(readProjectDiagnostics(projectsFile, projectId), record);
  assert.equal(readProjectDiagnostics(projectsFile, 'another-project'), undefined);

  const recordWithoutProfile = writeProjectDiagnostics(projectsFile, projectId, {
    launchProfileId: '',
    failedAt: 43
  });
  assert.equal(Object.hasOwn(recordWithoutProfile, 'launchProfileId'), false);

  clearProjectDiagnostics(projectsFile, projectId);
  assert.equal(readProjectDiagnostics(projectsFile, projectId), undefined);
});

test('retains missing-required-env kind on the diagnostic summary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-diag-kind-'));
  const projectsFile = path.join(root, 'projects.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const record = writeProjectDiagnostics(projectsFile, 'api', {
    summary: {
      title: 'Start failed',
      message: 'Missing required environment variables for this launch profile: API_KEY.',
      kind: 'missing-required-env'
    },
    output: ''
  });
  assert.equal(record.failureSummary.kind, 'missing-required-env');
  assert.equal(readProjectDiagnostics(projectsFile, 'api').failureSummary.kind, 'missing-required-env');
});

test('redacts sensitive values from saved commands and summaries', () => {
  const value = redactSensitiveText('CLIENT_SECRET="value with spaces" npm start');

  assert.equal(value, 'CLIENT_SECRET=[redacted] npm start');
});

test('wires retained-failure diagnosis into the sidebar without sending to an agent', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(extension, /showProjectDiagnosis[\s\S]*readProjectDiagnostics/);
  assert.doesNotMatch(extension, /showProjectDiagnosis[\s\S]{0,300}projectFailureSummaries\.has/);
  assert.match(extension, /copyDiagnosisRequest[\s\S]*vscode\.env\.clipboard\.writeText/);
  assert.doesNotMatch(extension, /copyDiagnosisRequest[\s\S]{0,1000}(?:fetch\(|openExternal|spawn\()/);
  assert.match(extension, /installMcpBridge[\s\S]*project-output\.js[\s\S]*project-diagnostics\.js/);
  assert.match(extension, /savedProjectRevision = projectConfigurationRevision\(project\)/);
  assert.match(extension, /projectRevision: savedProjectRevision/);
  assert.match(webview, /projectOutput\.canAskAgent[\s\S]*Ask your agent/);
  assert.match(webview, /Nothing is sent automatically/);
  assert.match(webview, /Open Agent connections/);
  assert.match(webview, /data-action="copy-diagnosis-request"/);
  assert.match(styles, /\.diagnosis-context/);
});

test('exposes Ask your agent on the row More menu from a host boolean only', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const router = fs.readFileSync(
    path.join(root, 'src', 'webview', 'webview-message-router.js'),
    'utf8'
  );

  assert.match(
    extension,
    /canAskAgent: Boolean\(readProjectDiagnostics\(this\.projectsFile, project\.id\)\)/
  );
  assert.match(
    webview,
    /data-action="show-terminal"[\s\S]*project\.canAskAgent \? `[\s\S]*data-action="ask-agent"[\s\S]*aria-label="Ask your agent about \$\{projectName\}"[\s\S]*<span>Ask your agent<\/span>[\s\S]*data-action="restart"/
  );
  assert.match(
    webview,
    /projectOutput\.canAskAgent \? `<button class="diagnosis-open-button" data-action="ask-agent" data-id="\$\{escapeHtml\(projectOutput\.projectId\)\}">Ask your agent<\/button>`/
  );
  assert.match(
    webview,
    /'ask-agent': \(\) => \{[\s\S]*closeMenus\(\);[\s\S]*type: 'showDiagnosis', id: button\.dataset\.id/
  );
  assert.match(router, /showDiagnosis: \(message\) => host\.showProjectDiagnosis\(message\.id\)/);
  assert.doesNotMatch(webview, /data-action="ask-agent"[\s\S]{0,400}copyStartFailure|copy-start-failure/);
});
