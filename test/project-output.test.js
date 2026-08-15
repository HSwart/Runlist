const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  appendProjectOutput,
  formatProjectOutput,
  listenToProjectOutput
} = require('../project-output');

test('combines project output and removes terminal color codes', () => {
  const output = appendProjectOutput('Ready\n', '\u001b[31mFailed\u001b[0m\n');
  assert.equal(output, 'Ready\nFailed\n');
});

test('keeps only the newest output within the configured limit', () => {
  assert.equal(appendProjectOutput('12345', '67890', 6), '567890');
});

test('listens to both stdout and stderr from a project process', () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const chunks = [];
  listenToProjectOutput(child, (chunk) => chunks.push(chunk));

  child.stdout.write('server ready\n');
  child.stderr.write('warning\n');

  assert.deepEqual(chunks, ['server ready\n', 'warning\n']);
});

test('formats common structured log lines and preserves raw output', () => {
  assert.deepEqual(formatProjectOutput([
    'time="2026-08-15T17:17:49+02:00" level=warning msg="already running, ignoring"',
    '{"level":"error","message":"Could not connect","timestamp":"2026-08-15T17:18:00Z"}',
    'GoSearch UI: http://127.0.0.1:8787'
  ].join('\n')), [
    {
      kind: 'structured',
      level: 'warning',
      message: 'already running, ignoring',
      time: '17:17:49'
    },
    {
      kind: 'structured',
      level: 'error',
      message: 'Could not connect',
      time: '17:18:00'
    },
    {
      kind: 'raw',
      message: 'GoSearch UI: http://127.0.0.1:8787'
    }
  ]);
});
