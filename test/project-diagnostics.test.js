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
    failedAt: 42
  });

  assert.equal(record.retainedOutput, '');
  assert.equal(record.failureSummary.message, 'TOKEN: [redacted]');
  assert.equal(path.dirname(diagnosticsPath(projectsFile, projectId)), path.join(root, 'failed-start-diagnostics'));
  assert.deepEqual(readProjectDiagnostics(projectsFile, projectId), record);
  assert.equal(readProjectDiagnostics(projectsFile, 'another-project'), undefined);

  clearProjectDiagnostics(projectsFile, projectId);
  assert.equal(readProjectDiagnostics(projectsFile, projectId), undefined);
});

test('redacts sensitive values from saved commands and summaries', () => {
  const value = redactSensitiveText('CLIENT_SECRET="value with spaces" npm start');

  assert.equal(value, 'CLIENT_SECRET=[redacted] npm start');
});

test('wires retained-failure diagnosis into the sidebar without sending to an agent', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(extension, /showProjectDiagnosis[\s\S]*readProjectDiagnostics/);
  assert.doesNotMatch(extension, /showProjectDiagnosis[\s\S]{0,300}projectFailureSummaries\.has/);
  assert.match(extension, /copyDiagnosisRequest[\s\S]*vscode\.env\.clipboard\.writeText/);
  assert.doesNotMatch(extension, /copyDiagnosisRequest[\s\S]{0,1000}(?:fetch\(|openExternal|spawn\()/);
  assert.match(extension, /installMcpBridge[\s\S]*project-output\.js[\s\S]*project-diagnostics\.js/);
  assert.match(webview, /projectOutput\.canAskAgent[\s\S]*Ask your agent/);
  assert.match(webview, /Nothing is sent automatically/);
  assert.match(webview, /Open Agent connections/);
  assert.match(webview, /data-action="copy-diagnosis-request"/);
  assert.match(styles, /\.diagnosis-context/);
});
