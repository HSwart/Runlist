const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { handoffProjectSafely } = require('../project-process');

function actions(calls, overrides = {}) {
  return {
    reserveRequested: async () => {
      calls.push('reserve-requested');
      return true;
    },
    currentConflict: async () => {
      calls.push('verify-owner');
      return { owner: { id: 'alpha' } };
    },
    stop: async () => {
      calls.push('stop-owner');
      return true;
    },
    waitForStop: async () => {
      calls.push('wait-for-release');
      return true;
    },
    start: async () => {
      calls.push('start-requested');
      return true;
    },
    releaseRequested: async () => calls.push('release-requested'),
    ...overrides
  };
}

test('holds the requested-project reservation through a successful safe handoff', async () => {
  const calls = [];
  const result = await handoffProjectSafely(new Set(), 'beta', actions(calls));

  assert.equal(result, true);
  assert.deepEqual(calls, [
    'reserve-requested',
    'verify-owner',
    'stop-owner',
    'wait-for-release',
    'start-requested'
  ]);
});

test('does not start and releases the requested reservation when stop fails', async () => {
  const calls = [];
  const result = await handoffProjectSafely(new Set(), 'beta', actions(calls, {
    stop: async () => {
      calls.push('stop-owner');
      return false;
    }
  }));

  assert.equal(result, false);
  assert.deepEqual(calls, [
    'reserve-requested',
    'verify-owner',
    'stop-owner',
    'release-requested'
  ]);
});

test('does not stop anything when current ownership is stale or ambiguous', async () => {
  const calls = [];
  const result = await handoffProjectSafely(new Set(), 'beta', actions(calls, {
    currentConflict: async () => {
      calls.push('verify-owner');
      return undefined;
    }
  }));

  assert.equal(result, false);
  assert.deepEqual(calls, ['reserve-requested', 'verify-owner', 'release-requested']);
});

test('does not start when reservations remain after the owned process stops', async () => {
  const calls = [];
  const result = await handoffProjectSafely(new Set(), 'beta', actions(calls, {
    waitForStop: async () => {
      calls.push('wait-for-release');
      return false;
    }
  }));

  assert.equal(result, false);
  assert.deepEqual(calls, [
    'reserve-requested',
    'verify-owner',
    'stop-owner',
    'wait-for-release',
    'release-requested'
  ]);
});

test('rejects duplicate handoffs for the same requested project', async () => {
  const active = new Set();
  let releaseStop;
  const first = handoffProjectSafely(active, 'beta', actions([], {
    stop: () => new Promise((resolve) => {
      releaseStop = resolve;
    })
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await handoffProjectSafely(active, 'beta', actions([])), false);
  releaseStop(true);
  assert.equal(await first, true);
});

test('wires one accessible contextual control through guarded handoff and port recovery', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(__dirname, '..', 'project-lifecycle.js'), 'utf8');
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(webview, /const primaryAction = projectPrimaryAction\(project\)/);
  assert.match(webview, /class="run-button[\s\S]*data-action="\$\{primaryAction\.action\}"[\s\S]*aria-label="\$\{actionTitle\}"/);
  assert.match(webview, /data-action="force-close-ports"[\s\S]*Close configured ports/);
  assert.match(webview, /'force-close-ports': \(\) => \{[\s\S]*type: 'forceCloseProjectPorts'/);
  assert.match(webview, /'force-close-ports-and-start': \(\) => \{[\s\S]*type: 'forceCloseProjectPortsAndStart'/);
  assert.match(extension, /handoffProject\(id\)[\s\S]*this\.lifecycle\.handoff\(id\)/);
  assert.match(extension, /async forceCloseProjectPorts\(id, intent\)[\s\S]*recoverProjectPorts\(project, intent/);
  assert.match(extension, /showWarningMessage\([\s\S]*\{ modal: true, detail: confirmation\.detail \}/);
  assert.match(lifecycle, /handoffProjectSafely\(this\.host\.handoffProjectIds, id/);
});
