const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  appendProjectOutput,
  createOutputUpdateScheduler,
  formatProjectOutput,
  listenToProjectOutput,
  sanitizeProjectOutput
} = require('../project-output');

test('combines project output and removes terminal color codes', () => {
  const output = appendProjectOutput('Ready\n', '\u001b[31mFailed\u001b[0m\n');
  assert.equal(sanitizeProjectOutput(output), 'Ready\nFailed\n');
});

test('preserves split terminal color codes until the complete output is sanitized', () => {
  const output = ['\u001b[3', '1mred\u001b[', '0m']
    .reduce((current, chunk) => appendProjectOutput(current, chunk), '');

  assert.equal(sanitizeProjectOutput(output), 'red');
  assert.deepEqual(formatProjectOutput(output), [{ kind: 'raw', message: 'red' }]);
});

test('keeps only the newest output within the configured limit', () => {
  assert.equal(appendProjectOutput('12345', '67890', 6), '567890');
});

test('does not expose an ANSI sequence fragment when old output is trimmed', () => {
  const output = appendProjectOutput('12', '\u001b[31mRED', 7);

  assert.equal(output, 'RED');
  assert.equal(sanitizeProjectOutput(output), 'RED');
});

test('keeps the output buffer bounded when a malformed CSI sequence rolls over', () => {
  const output = appendProjectOutput('', `\u001b[\n${'x'.repeat(100)}`, 20);

  assert.equal(output, 'x'.repeat(20));
  assert.equal(output.length, 20);
});

test('removes complete OSC sequences before the output buffer is trimmed', () => {
  const output = appendProjectOutput('', '12\u001b]8;;https://example.com\u0007LINK', 16);

  assert.equal(output, 'LINK');
  assert.equal(sanitizeProjectOutput(output), 'LINK');
});

test('does not expose a standard escape sequence fragment at rollover', () => {
  const output = appendProjectOutput('', '12\u001b(0TEXT', 6);

  assert.equal(output, 'TEXT');
  assert.equal(sanitizeProjectOutput(output), 'TEXT');
});

test('hides an incomplete OSC sequence until its remaining chunk arrives', () => {
  let output = appendProjectOutput('Ready\n', '\u001b]8;;https://example.com');
  assert.equal(sanitizeProjectOutput(output), 'Ready\n');

  output = appendProjectOutput(output, '\u0007Link');
  assert.equal(sanitizeProjectOutput(output), 'Ready\nLink');
});

test('keeps a split ANSI sequence bounded and completes it on the next chunk', () => {
  let output = appendProjectOutput('xx', `\u001b[${'3'.repeat(20)}`, 10);
  assert.equal(output.length, 10);
  assert.equal(sanitizeProjectOutput(output), '');

  output = appendProjectOutput(output, 'mRED', 10);
  assert.equal(output, 'RED');
  assert.ok(output.length <= 10);
});

test('keeps incomplete ANSI state bounded at very small limits', () => {
  const output = appendProjectOutput('\u001b[', '31', 2);

  assert.equal(output, '\u001b[');
  assert.equal(output.length, 2);
});

test('listens to both stdout and stderr from a project process', () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const chunks = [];
  listenToProjectOutput(child, (chunk) => chunks.push(chunk));

  child.stdout.write('server ready\n');
  child.stderr.write('warning\n');

  assert.deepEqual(chunks, ['server ready\n', 'warning\n']);
});

test('coalesces rapid output refreshes and sends the latest value', async () => {
  const updates = [];
  const scheduler = createOutputUpdateScheduler((value) => updates.push(value), 5);

  scheduler.schedule('first');
  scheduler.schedule('second');
  scheduler.schedule('latest');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(updates, ['latest']);
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
