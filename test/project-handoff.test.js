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

test('wires one accessible handoff action through the guarded stop and start paths', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(webview, /const handoffLabel = `Stop \$\{conflictOwnerName\} and start \$\{projectName\}`/);
  assert.match(webview, /class="handoff-button" data-action="handoff"[\s\S]*aria-label="\$\{handoffLabel\}"/);
  assert.match(webview, /handoff: \(\) => \{[\s\S]*type: 'handoffProject'/);
  assert.match(webview, /const indicator = conflicted[\s\S]*\? 'conflict'[\s\S]*: webNotResponding/);
  assert.match(extension, /handoffProjectSafely\(this\.handoffProjectIds, id/);
  assert.match(extension, /stop: \(conflict\) => this\.stopProject\(conflict\.owner\.id[\s\S]*expectedOwnershipToken/);
  assert.match(extension, /start: \(\) => this\.startProject\(id,[\s\S]*ownershipReserved: true/);
});
