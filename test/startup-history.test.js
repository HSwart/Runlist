const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  appendStartupHistory,
  averageReadyDuration,
  clearStartupHistory,
  MAX_STARTUP_FAILURE_SUMMARY_CHARS,
  MAX_STARTUP_HISTORY,
  normalizeFailureSummary,
  readStartupHistory,
  replaceTimedOutStartupHistory,
  startupHistoryDirectory,
  startupHistoryEntry
} = require('../src/lifecycle/startup-history');
const { readShippedHostSource } = require('./helpers/extension-source');

test('averages only valid ready durations with deterministic rounding', () => {
  assert.equal(averageReadyDuration([
    { outcome: 'ready', durationMs: 1000 },
    { outcome: 'failed', durationMs: 20 },
    { outcome: 'ready', durationMs: 2001 },
    { outcome: 'stopped', durationMs: 10 },
    { outcome: 'ready', durationMs: -1 },
    { outcome: 'ready', durationMs: Number.NaN },
    { outcome: 'ready' }
  ]), 1501);
  assert.equal(averageReadyDuration([{ outcome: 'ready', durationMs: 1250 }]), 1250);
  assert.equal(averageReadyDuration([{ outcome: 'ready', durationMs: 0 }]), 0);
  assert.equal(averageReadyDuration([{ outcome: 'failed', durationMs: 500 }]), undefined);
  assert.equal(averageReadyDuration(undefined), undefined);
});

test('classifies completed managed-start outcomes and attaches details only to failures', () => {
  assert.deepEqual(startupHistoryEntry('ready', 1000, 3500), {
    outcome: 'ready',
    completedAt: 3500,
    durationMs: 2500
  });
  assert.equal(startupHistoryEntry('running', 1000, 3500), undefined);
  assert.equal(startupHistoryEntry('failed', 3500, 1000), undefined);
  assert.deepEqual(startupHistoryEntry('failed', 1000, 3500, 'Command not found'), {
    outcome: 'failed',
    completedAt: 3500,
    durationMs: 2500,
    failureSummary: 'Command not found'
  });
  assert.equal(startupHistoryEntry('ready', 1000, 3500, 'ignored').failureSummary, undefined);
});

test('sanitizes, redacts, and bounds retained failure summaries', () => {
  const summary = normalizeFailureSummary(`\u001b[31mTOKEN=secret\u001b[0m\n${'x'.repeat(400)}😀`);
  assert.equal(summary.includes('\u001b'), false);
  assert.match(summary, /TOKEN=\[redacted\]/);
  assert.equal(summary.length <= MAX_STARTUP_FAILURE_SUMMARY_CHARS, true);
  assert.equal(summary.endsWith('…'), true);
  assert.doesNotMatch(summary, /[\ud800-\udbff]$/);
  assert.equal(normalizeFailureSummary('  \n  '), undefined);
});

test('persists a deterministic bounded history and remains backward compatible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-history-'));
  const projectsFile = path.join(root, 'projects.json');
  assert.deepEqual(readStartupHistory(projectsFile, 'project'), []);

  for (let index = 0; index < MAX_STARTUP_HISTORY + 3; index += 1) {
    appendStartupHistory(projectsFile, 'project', {
      outcome: index % 3 === 0 ? 'failed' : index % 3 === 1 ? 'timed-out' : 'ready',
      completedAt: 1000 + index,
      durationMs: index * 100
    });
  }

  const history = readStartupHistory(projectsFile, 'project');
  assert.equal(history.length, MAX_STARTUP_HISTORY);
  assert.deepEqual(history.map((entry) => entry.completedAt), [1003, 1004, 1005, 1006, 1007]);
  assert.deepEqual(Object.keys(history[0]).sort(), ['completedAt', 'durationMs', 'outcome']);
  assert.equal(fs.readdirSync(startupHistoryDirectory(projectsFile, 'project')).length, MAX_STARTUP_HISTORY);
});

test('ignores malformed retained history without breaking older installations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-history-malformed-'));
  const projectsFile = path.join(root, 'projects.json');
  const directory = startupHistoryDirectory(projectsFile, 'project');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '1000-00000000-0000-0000-0000-000000000000.json'), '{broken');

  assert.deepEqual(readStartupHistory(projectsFile, 'project'), []);
  assert.doesNotThrow(() => appendStartupHistory(projectsFile, 'project', {
    outcome: 'ready',
    completedAt: 2000,
    durationMs: 500
  }));
  assert.deepEqual(readStartupHistory(projectsFile, 'project'), [{
    outcome: 'ready',
    completedAt: 2000,
    durationMs: 500
  }]);
});

test('upgrades a timed-out attempt to one inspectable failed entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-history-upgrade-'));
  const projectsFile = path.join(root, 'projects.json');
  appendStartupHistory(projectsFile, 'project', {
    outcome: 'timed-out',
    completedAt: 31_000,
    durationMs: 30_000
  });

  assert.equal(replaceTimedOutStartupHistory(projectsFile, 'project', 1000, {
    outcome: 'failed',
    completedAt: 34_000,
    durationMs: 33_000,
    failureSummary: 'Database connection refused'
  }), true);
  assert.deepEqual(readStartupHistory(projectsFile, 'project'), [{
    outcome: 'failed',
    completedAt: 34_000,
    durationMs: 33_000,
    failureSummary: 'Database connection refused'
  }]);
  assert.equal(fs.readdirSync(startupHistoryDirectory(projectsFile, 'project')).length, 1);
});

test('keeps concurrent extension-host writers bounded without lost-file corruption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-history-concurrent-'));
  const projectsFile = path.join(root, 'projects.json');
  const modulePath = path.join(__dirname, '..', 'src', 'lifecycle', 'startup-history.js');
  const worker = `
    const { appendStartupHistory } = require(process.argv[1]);
    const projectsFile = process.argv[2];
    const offset = Number(process.argv[3]);
    for (let index = 0; index < 12; index += 1) {
      appendStartupHistory(projectsFile, 'shared-project', {
        outcome: index % 2 ? 'ready' : 'failed',
        completedAt: offset + index,
        durationMs: index
      });
    }
  `;
  const runWorker = (offset) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker, modulePath, projectsFile, String(offset)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`History worker exited with ${code}: ${stderr}`));
    });
  });

  await Promise.all([runWorker(1000), runWorker(2000), runWorker(3000), runWorker(4000)]);
  const history = readStartupHistory(projectsFile, 'shared-project');
  assert.equal(history.length, MAX_STARTUP_HISTORY);
  assert.deepEqual(history.map((entry) => entry.completedAt), [4007, 4008, 4009, 4010, 4011]);
  assert.equal(fs.readdirSync(startupHistoryDirectory(projectsFile, 'shared-project')).filter((name) => name.endsWith('.json')).length, MAX_STARTUP_HISTORY);
});

test('deleting startup history removes only that project history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-history-delete-'));
  const projectsFile = path.join(root, 'projects.json');
  appendStartupHistory(projectsFile, 'first', { outcome: 'ready', completedAt: 2, durationMs: 1 });
  appendStartupHistory(projectsFile, 'second', { outcome: 'failed', completedAt: 3, durationMs: 2 });

  clearStartupHistory(projectsFile, 'first');
  assert.deepEqual(readStartupHistory(projectsFile, 'first'), []);
  assert.equal(readStartupHistory(projectsFile, 'second').length, 1);
});

test('wires bounded outcomes and an accessible non-color-only ribbon into the lifecycle', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(extension, /status === 'running'[\s\S]*recordStartupOutcome\(id, 'ready', readyAt\)/);
  assert.match(extension, /\['not-ready', 'not-responding'\][\s\S]*recordStartupOutcome\(id, 'timed-out'\)/);
  assert.match(extension, /showStartFailure\(project, details[\s\S]*startFailureSummary[\s\S]*recordStartupOutcome\(project\.id, 'failed'[\s\S]*summary\.message\)/);
  assert.match(extension, /metadata\.historyOutcome !== 'timed-out'[\s\S]*replaceTimedOutStartupHistory/);
  assert.match(extension, /clearStartupHistory\(this\.projectsFile, id\)/);
  assert.match(extension, /averageReadyDurationMs: averageReadyDuration\(startupHistory\)/);
  assert.match(webview, /class="startup-history" role="group" aria-label=/);
  assert.doesNotMatch(webview, /class="startup-history-ribbon" aria-hidden="true"/);
  assert.match(webview, /code: 'OK'[\s\S]*code: 'FAIL'[\s\S]*code: 'SLOW'/);
  assert.match(webview, /if \(!entry\.failureSummary\)[\s\S]*<span class="startup-history-entry[\s\S]*data-action="show-startup-failure"/);
  assert.match(webview, /escapeHtml\(selectedFailure\.failureSummary\)/);
  assert.match(webview, /Number\.isFinite\(project\.averageReadyDurationMs\)[\s\S]*averageReadyDuration !== undefined[\s\S]*aria-label="Average ready time:[\s\S]*Avg ready/);
  assert.match(webview, /function closeStartupFailure[\s\S]*renderList\(\)[\s\S]*data-action="show-startup-failure"[\s\S]*\.focus\(\)/);
  assert.match(webview, /if \(!history\.length \|\| !project\.detailsExpanded\) \{[\s\S]*return ''/);
  assert.match(webview, /!project\.services\?\.length && project\.startupHistory\?\.length[\s\S]*project-details-toggle-row/);
  assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(52px, 1fr\)\)/);
  assert.match(styles, /\.startup-history > header[\s\S]*flex-wrap: wrap/);
  assert.match(styles, /\.startup-history-stats[\s\S]*flex-wrap: wrap/);
});
