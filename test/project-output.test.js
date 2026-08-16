const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  appendProjectOutput,
  createOutputUpdateScheduler,
  formatProjectOutput,
  listenToProjectOutput,
  projectOutputPeek,
  sanitizeProjectOutput,
  startFailureSummary
} = require('../project-output');

test('combines project output and removes terminal color codes', () => {
  const output = appendProjectOutput('Ready\n', '\u001b[31mFailed\u001b[0m\n');
  assert.equal(sanitizeProjectOutput(output), 'Ready\nFailed\n');
});

test('shows the latest three meaningful sanitized output lines', () => {
  const output = [
    '$ concurrently "pnpm web" "pnpm api"',
    '[web] $ pnpm dev:web',
    '\u001b[32m[web] ready on http://localhost:5173\u001b[0m',
    '[api] info: listening on 4311',
    '[api] warning: cache cold',
    '[api] error: database unavailable'
  ].join('\r\n');

  assert.deepEqual(projectOutputPeek(output), [
    { kind: 'structured', level: 'info', message: '[api] listening on 4311', time: '' },
    { kind: 'structured', level: 'warning', message: '[api] cache cold', time: '' },
    { kind: 'structured', level: 'error', message: '[api] database unavailable', time: '' }
  ]);
});

test('keeps useful Unicode and structured severity while suppressing wrapper echoes', () => {
  const output = [
    '> api@1.0.0 dev',
    '[api] $ node server.js',
    'info: Café ready ✅',
    'warning: résumé cache is cold',
    'error: Verbindung fehlgeschlagen'
  ].join('\n');

  assert.deepEqual(projectOutputPeek(output), [
    { kind: 'structured', level: 'info', message: 'Café ready ✅', time: '' },
    { kind: 'structured', level: 'warning', message: 'résumé cache is cold', time: '' },
    { kind: 'structured', level: 'error', message: 'Verbindung fehlgeschlagen', time: '' }
  ]);
});

test('bounds output peek work and individual DOM lines for verbose output', () => {
  const output = `${'old\n'.repeat(10000)}${'x'.repeat(1000)}\nlatest`;
  const started = Date.now();
  const peek = projectOutputPeek(output);

  assert.equal(peek.length, 3);
  assert.equal(peek.at(-1).message, 'latest');
  assert.equal(peek.at(-2).message.length, 400);
  assert.match(peek.at(-2).message, /…$/);
  assert.ok(Date.now() - started < 1000);
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

test('keeps an unfinished terminal string active across later escape sequences', () => {
  let output = appendProjectOutput('', `\u001b]title\u001b[31m${'x'.repeat(100)}`, 20);
  assert.equal(output.length, 20);
  assert.equal(sanitizeProjectOutput(output), '');

  output = appendProjectOutput(output, '\u0007VISIBLE', 20);
  assert.equal(output, 'VISIBLE');
  assert.equal(sanitizeProjectOutput(output), 'VISIBLE');
});

test('does not terminate non-OSC terminal strings at BEL', () => {
  const output = '\u001bPprivate\u0007still-private\u001b\\VISIBLE';

  assert.equal(sanitizeProjectOutput(output), 'VISIBLE');
});

test('terminates terminal strings at the single-byte ST character', () => {
  const output = '\u001bPprivate\u009cVISIBLE';

  assert.equal(sanitizeProjectOutput(output), 'VISIBLE');
});

test('handles C1 CSI and string introducers', () => {
  const csiOutput = appendProjectOutput('', '12\u009b31mRED', 6);
  assert.equal(sanitizeProjectOutput(csiOutput), 'RED');

  assert.equal(sanitizeProjectOutput('\u009dtitle\u009cVISIBLE'), 'VISIBLE');
  assert.equal(sanitizeProjectOutput('\u0090private\u009cVISIBLE'), 'VISIBLE');
});

test('keeps output after CAN and SUB cancel a terminal string', () => {
  assert.equal(sanitizeProjectOutput('\u001b]title\u0018VISIBLE'), 'VISIBLE');
  assert.equal(sanitizeProjectOutput('\u001bPprivate\u001aVISIBLE'), 'VISIBLE');
});

test('consumes malformed CSI bytes before trimming visible output', () => {
  const output = appendProjectOutput('', '12\u001b[31\nmRED', 6);

  assert.equal(output, 'mRED');
  assert.equal(sanitizeProjectOutput(output), 'mRED');
});

test('rescans an ANSI sequence that interrupts another sequence', () => {
  const escOutput = appendProjectOutput('', '12\u001b[31\u001b[32mRED', 6);
  const c1Output = appendProjectOutput('', '12\u001b[31\u009b32mRED', 6);
  const standardOutput = appendProjectOutput('', '12\u001b(\u001b[32mRED', 6);

  assert.equal(sanitizeProjectOutput(escOutput), 'RED');
  assert.equal(sanitizeProjectOutput(c1Output), 'RED');
  assert.equal(sanitizeProjectOutput(standardOutput), 'RED');
});

test('removes a standalone C1 ST control character', () => {
  assert.equal(sanitizeProjectOutput('A\u009cB'), 'AB');
});

test('does not split an emoji at a plain-text rollover boundary', () => {
  assert.equal(appendProjectOutput('', '12😀XYZ', 4), 'XYZ');
});

test('does not split an emoji while bounding an incomplete terminal string', () => {
  const output = appendProjectOutput('', '\u001b]12😀XYZ', 6);

  assert.equal(output, '\u001b]XYZ');
  assert.equal(output.length, 5);
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

test('keeps high-volume plain-text rollover responsive', () => {
  let output = '';
  const started = Date.now();

  for (let index = 0; index < 10000; index += 1) {
    output = appendProjectOutput(output, 'line\n');
  }

  assert.equal(output.length, 20000);
  assert.ok(Date.now() - started < 2500);
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

test('parses escaped quoted fields without excessive backtracking', { timeout: 1000 }, () => {
  const escaped = 'level=info msg="path C:\\\\temp says \\"ready\\""';
  assert.deepEqual(formatProjectOutput(escaped), [{
    kind: 'structured',
    level: 'info',
    message: 'path C:\\temp says "ready"',
    time: ''
  }]);

  const malformed = `level="${'\\!'.repeat(5000)}`;
  assert.equal(formatProjectOutput(malformed).length, 1);
});

test('surfaces a useful Windows failure ahead of process-manager wrapper output', () => {
  const output = [
    '[web] VITE ready',
    "[api] [node] 'sh' is not recognized as an internal or external command,",
    '[api] [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] command failed',
    '$ concurrently -k -n web,api "pnpm dev:web" "pnpm dev:api"'
  ].join('\r\n');

  assert.deepEqual(startFailureSummary(output, { code: 1 }), {
    title: 'Start failed',
    message: "[api] [node] 'sh' is not recognized as an internal or external command,",
    outcome: 'Process exited with code 1.'
  });
});

test('surfaces useful Unix failures from combined project output', () => {
  assert.deepEqual(startFailureSummary([
    'starting server',
    '/bin/sh: vite: command not found'
  ].join('\n'), { code: 127 }), {
    title: 'Start failed',
    message: '/bin/sh: vite: command not found',
    outcome: 'Process exited with code 127.'
  });
});

test('falls back safely to an exit code, signal, or explicit spawn error', () => {
  assert.deepEqual(startFailureSummary('ordinary output', { code: 1 }), {
    title: 'Start failed',
    message: 'Process exited with code 1.',
    outcome: ''
  });
  assert.deepEqual(startFailureSummary('', { signal: 'SIGTERM' }), {
    title: 'Start failed',
    message: 'Process was terminated by SIGTERM.',
    outcome: ''
  });
  assert.deepEqual(startFailureSummary('', { detail: 'spawn ENOENT' }), {
    title: 'Start failed',
    message: 'spawn ENOENT',
    outcome: ''
  });
});

test('keeps failure selection bounded for verbose and unsafe output', { timeout: 1000 }, () => {
  const unsafe = '<img src=x onerror=alert(1)> fatal error';
  const output = `${'noise\n'.repeat(100000)}${unsafe}`;

  assert.equal(startFailureSummary(output, { code: 1 }).message, unsafe);
});

test('renders an escaped accessible failure summary with a supported Latest icon', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

  assert.match(webview, /icon\('chevron-down', 'jump-icon'\)/);
  assert.doesNotMatch(webview, /icon\('arrow-down'/);
  assert.match(webview, /outputFailureSummaryHtml[\s\S]*escapeHtml\(summary\.message\)/);
  assert.match(webview, /class="output-failure-summary" role="status" aria-live="polite"/);
  assert.match(webview, /failure\.innerHTML = outputFailureSummaryHtml\(event\.data\.failureSummary\)/);
  assert.match(webview, /failureSummary[\s\S]*No command output was captured\./);
  assert.match(styles, /\.output-failure-summary \{[\s\S]*--vscode-inputValidation-errorBackground/);
});

test('renders an accessible bounded live peek without replacing active selection or focus', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

  assert.match(extension, /type: 'projectOutputPeek'[\s\S]*entries: projectOutputPeek\(rawOutput\)/);
  assert.match(webview, /class="project-output-peek" tabindex="0" aria-label="Latest output for/);
  assert.match(webview, /data-action="output"[\s\S]*View output/);
  assert.match(webview, /slot\.contains\(document\.activeElement\)/);
  assert.match(webview, /selection\.getRangeAt\(0\)\.intersectsNode\(slot\)/);
  assert.match(webview, /pendingOutputPeeks\.set\(key, entries \|\| \[\]\)/);
  assert.doesNotMatch(webview, /project-output-peek[^\n]*aria-live/);
  assert.match(styles, /\.project-output-peek \{[\s\S]*--vscode-textCodeBlock-background/);
  assert.match(styles, /\.output-peek-line\.warning[\s\S]*--vscode-editorWarning-foreground/);
  assert.match(styles, /\.output-peek-line\.error[\s\S]*--vscode-errorForeground/);
});
