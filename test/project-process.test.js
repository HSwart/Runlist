const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  ProcessOwnershipStore,
  projectProcessSpawnOptions,
  terminateProcessTree,
  terminateTrackedProcess
} = require('../project-process');

test('launches POSIX commands in an owned process group and keeps Windows launches attached', () => {
  assert.deepEqual(projectProcessSpawnOptions('linux'), { detached: true });
  assert.deepEqual(projectProcessSpawnOptions('darwin'), { detached: true });
  assert.deepEqual(projectProcessSpawnOptions('win32'), { detached: false, windowsHide: true });
});

test('runs explicit custom stop commands through the platform shell', () => {
  assert.deepEqual(customStopSpawnOptions('linux'), {
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  assert.deepEqual(customStopSpawnOptions('darwin'), {
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  assert.deepEqual(customStopSpawnOptions('win32'), {
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
});

test('terminates only the requested POSIX process group', async () => {
  const signals = [];
  let groupAlive = true;
  const otherProcess = { pid: 202 };
  const processes = new Map([
    ['requested', { pid: 101 }],
    ['other', otherProcess]
  ]);

  assert.equal(await terminateTrackedProcess(processes, 'requested', {
    platform: 'linux',
    kill: (pid, signal) => {
      if (signal === 0) {
        if (groupAlive) {
          return;
        }
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
      signals.push([pid, signal]);
      groupAlive = false;
    }
  }), true);
  assert.deepEqual(signals, [[-101, 'SIGTERM']]);
  assert.equal(processes.has('requested'), false);
  assert.equal(processes.get('other'), otherProcess);
  assert.equal(await terminateTrackedProcess(processes, 'missing'), false);
});

test('escalates only the owned POSIX process group when descendants ignore SIGTERM', async () => {
  const signals = [];
  let groupAlive = true;
  await terminateProcessTree(505, {
    platform: 'darwin',
    terminateTimeoutMs: 0,
    kill: (pid, signal) => {
      if (signal === 0) {
        if (groupAlive) {
          return;
        }
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') {
        groupAlive = false;
      }
    }
  });
  assert.deepEqual(signals, [[-505, 'SIGTERM'], [-505, 'SIGKILL']]);
});

test('keeps a live process handle when tree termination fails', async () => {
  const child = { pid: 606, exitCode: null, signalCode: null };
  const processes = new Map([['project', child]]);
  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'linux',
    kill: () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }
  }), /not permitted/);
  assert.equal(processes.get('project'), child);
});

test('fails safely when the process identifier is unavailable', async () => {
  await assert.rejects(
    terminateProcessTree(undefined, { platform: 'linux' }),
    /valid process identifier/
  );
});

test('terminates an exact Windows process tree with taskkill', async () => {
  const calls = [];
  await terminateProcessTree(404, {
    platform: 'win32',
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      process.nextTick(() => child.emit('exit', 0));
      return child;
    }
  });

  assert.deepEqual(calls, [{
    command: 'taskkill.exe',
    args: ['/PID', '404', '/T', '/F'],
    options: {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    }
  }]);
});

test('uses only an approved post-confirmation snapshot during deletion', async () => {
  const signals = [];
  const stopCalls = [];
  const processes = new Map([
    ['unreviewed', { pid: 101 }],
    ['deleted-elsewhere', { pid: 102 }],
    ['approved', { pid: 103 }]
  ]);
  const approvedProject = { id: 'approved', reviewRequired: false, stopCommand: 'npm stop' };
  const options = {
    platform: 'darwin',
    kill: (pid, signal) => {
      if (signal === 0) {
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
      signals.push([pid, signal]);
    }
  };

  await cleanupTrackedProcessForDeletion(
    processes,
    'unreviewed',
    { id: 'unreviewed', reviewRequired: true },
    (project) => stopCalls.push(project),
    options
  );
  await cleanupTrackedProcessForDeletion(
    processes,
    'deleted-elsewhere',
    undefined,
    (project) => stopCalls.push(project),
    options
  );
  await cleanupTrackedProcessForDeletion(
    processes,
    'approved',
    approvedProject,
    async (project) => stopCalls.push(project),
    options
  );

  assert.deepEqual(signals, [[-101, 'SIGTERM'], [-102, 'SIGTERM']]);
  assert.deepEqual(stopCalls, [approvedProject]);
  assert.equal(processes.has('unreviewed'), false);
  assert.equal(processes.has('deleted-elsewhere'), false);
  assert.equal(processes.has('approved'), true);
});

test('coordinates owned process stopping across VS Code hosts without sharing kill authority', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-process-owner-'));
  const alive = new Set([101, 202, 303]);
  const isProcessAlive = (pid) => alive.has(pid);
  const owner = new ProcessOwnershipStore(directory, { pid: 101, platform: 'linux', isProcessAlive });
  const otherWindow = new ProcessOwnershipStore(directory, { pid: 202, platform: 'linux', isProcessAlive });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve('project-1'), undefined);
  owner.setProcess('project-1', 303, { state: 'starting', readinessDeadline: 12345 });
  assert.equal(otherWindow.snapshot().get('project-1').state, 'starting');
  assert.equal(otherWindow.snapshot().get('project-1').processActive, true);
  assert.equal(otherWindow.snapshot().get('project-1').readinessDeadline, 12345);
  owner.setState('project-1', 'not-ready');
  assert.equal(otherWindow.snapshot().get('project-1').state, 'not-ready');
  owner.setState('project-1', 'running');
  assert.equal(otherWindow.snapshot().get('project-1').state, 'running');
  assert.equal(otherWindow.reserve('project-1').kind, 'owned');
  assert.deepEqual(otherWindow.requestStop('project-1'), { kind: 'requested' });
  assert.equal(otherWindow.snapshot().get('project-1').state, 'stopping');
  assert.equal(otherWindow.cancelStopRequest('project-1'), true);
  assert.equal(otherWindow.snapshot().get('project-1').state, 'running');
  assert.deepEqual(otherWindow.requestStop('project-1'), { kind: 'requested' });
  assert.deepEqual(owner.consumeStopRequests(), ['project-1']);
  assert.deepEqual(owner.consumeStopRequests(), []);
  assert.equal(owner.release('project-1'), true);
  assert.equal(otherWindow.snapshot().has('project-1'), false);
});

test('fails safely when the launching host is gone but its child may still be running', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-process-uncertain-'));
  const alive = new Set([101, 202, 303]);
  const isProcessAlive = (pid) => alive.has(pid);
  const owner = new ProcessOwnershipStore(directory, { pid: 101, platform: 'win32', isProcessAlive });
  const otherWindow = new ProcessOwnershipStore(directory, { pid: 202, platform: 'win32', isProcessAlive });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  alive.delete(101);

  assert.equal(otherWindow.snapshot().get('project-1').ownerAvailable, false);
  assert.deepEqual(otherWindow.requestStop('project-1'), { kind: 'uncertain' });
  assert.equal(otherWindow.reserve('project-1').kind, 'uncertain');

  alive.delete(303);
  assert.equal(otherWindow.snapshot().has('project-1'), false);
  assert.equal(otherWindow.reserve('project-1'), undefined);
});
