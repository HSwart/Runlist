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
  shutdownTrackedProcesses,
  shouldRequestRemoteCustomStop,
  startExitFailed,
  terminateProcessTree,
  terminateTrackedProcess
} = require('../project-process');

test('runs a custom stop locally when the launching host is unavailable', () => {
  const project = { stopCommand: 'docker compose down' };

  assert.equal(shouldRequestRemoteCustomStop(project, {
    ownerAvailable: true,
    processActive: true
  }, false, false), true);
  assert.equal(shouldRequestRemoteCustomStop(project, {
    ownerAvailable: false,
    processActive: true
  }, false, false), false);
  assert.equal(shouldRequestRemoteCustomStop(project, {
    ownerAvailable: true,
    processActive: true
  }, true, false), false);
});

test('keeps ownership and port reservations until reload shutdown confirms the process stopped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-shutdown-'));
  const ownership = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: () => true
  });
  const { PortReservationStore } = require('../port-gate');
  const reservations = new PortReservationStore(path.join(root, 'ports'), {
    pid: 101,
    isProcessAlive: () => true
  });
  const project = { id: 'project-1', services: [{ name: 'web', port: 4310 }] };
  const processes = new Map([['project-1', { pid: 303 }]]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  ownership.reserve(project.id);
  ownership.setProcess(project.id, 303);
  reservations.reserve(project);
  let finishTermination;
  const termination = new Promise((resolve) => { finishTermination = resolve; });

  const shutdown = shutdownTrackedProcesses(processes, ownership, reservations, {
    terminateTrackedProcess: async () => termination
  });
  await Promise.resolve();

  assert.equal(ownership.snapshot().has(project.id), true);
  assert.equal(reservations.snapshot().has(project.id), true);

  finishTermination();
  assert.deepEqual(await shutdown, [{ status: 'fulfilled', value: true }]);
  assert.equal(ownership.snapshot().has(project.id), false);
  assert.equal(reservations.snapshot().has(project.id), false);
});

test('preserves ownership and port reservations when reload shutdown cannot stop the process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-shutdown-failure-'));
  const ownership = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: () => true
  });
  const { PortReservationStore } = require('../port-gate');
  const reservations = new PortReservationStore(path.join(root, 'ports'), {
    pid: 101,
    isProcessAlive: () => true
  });
  const project = { id: 'project-1', services: [{ name: 'web', port: 4310 }] };
  const processes = new Map([['project-1', { pid: 303 }]]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  ownership.reserve(project.id);
  ownership.setProcess(project.id, 303);
  reservations.reserve(project);

  const [result] = await shutdownTrackedProcesses(processes, ownership, reservations, {
    terminateTrackedProcess: async () => { throw new Error('still running'); }
  });

  assert.equal(result.status, 'rejected');
  assert.match(result.reason.message, /still running/);
  assert.equal(ownership.snapshot().has(project.id), true);
  assert.equal(reservations.snapshot().has(project.id), true);
});

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

test('retains a failed start when a managed command exits before its services are ready', () => {
  assert.equal(startExitFailed({ code: 0, hasServices: true, stoppedIntentionally: false }), true);
  assert.equal(startExitFailed({ code: 1, hasServices: false, stoppedIntentionally: false }), true);
  assert.equal(startExitFailed({ code: 0, hasServices: false, stoppedIntentionally: false }), false);
  assert.equal(startExitFailed({ code: 1, hasServices: true, stoppedIntentionally: true }), false);
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

test('accepts a termination race when the tracked process has already exited', async () => {
  const child = { pid: 607, exitCode: null, signalCode: null };
  const processes = new Map([['project', child]]);

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'darwin',
    kill: () => {
      child.exitCode = 0;
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }
  }), true);
  assert.equal(processes.has('project'), false);
});

test('does not hide unrelated tree termination failures after process exit', async () => {
  const child = { pid: 608, exitCode: 0, signalCode: null };
  const processes = new Map([['project', child]]);

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'darwin',
    kill: () => {
      throw Object.assign(new Error('unexpected failure'), { code: 'EINVAL' });
    }
  }), /unexpected failure/);
  assert.equal(processes.has('project'), false);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-owner-'));
  const alive = new Set([101, 202, 303]);
  const isProcessAlive = (pid) => alive.has(pid);
  const owner = new ProcessOwnershipStore(directory, { pid: 101, platform: 'linux', isProcessAlive });
  const otherWindow = new ProcessOwnershipStore(directory, { pid: 202, platform: 'linux', isProcessAlive });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve('project-1'), undefined);
  owner.setProcess('project-1', 303, {
    state: 'starting',
    readinessDeadline: 12345,
    launchedAt: 12000
  });
  assert.equal(owner.owns('project-1', 303), true);
  assert.equal(owner.owns('project-1', 304), false);
  assert.equal(otherWindow.owns('project-1', 303), false);
  assert.equal(otherWindow.snapshot().get('project-1').state, 'starting');
  assert.equal(otherWindow.snapshot().get('project-1').processActive, true);
  assert.equal(otherWindow.snapshot().get('project-1').readinessDeadline, 12345);
  assert.equal(otherWindow.snapshot().get('project-1').launchedAt, 12000);
  owner.setState('project-1', 'running', { readyAt: 15000 });
  assert.equal(otherWindow.snapshot().get('project-1').readyAt, 15000);
  owner.setState('project-1', 'not-ready');
  assert.equal(otherWindow.snapshot().get('project-1').state, 'not-ready');
  owner.setState('project-1', 'running');
  assert.equal(otherWindow.snapshot().get('project-1').state, 'running');
  assert.equal(otherWindow.reserve('project-1').kind, 'owned');
  const ownershipToken = otherWindow.snapshot().get('project-1').token;
  assert.deepEqual(otherWindow.requestStop('project-1', 'stale-token'), { kind: 'changed' });
  assert.deepEqual(otherWindow.requestStop('project-1', ownershipToken), { kind: 'requested' });
  assert.equal(otherWindow.snapshot().get('project-1').state, 'stopping');
  assert.equal(otherWindow.cancelStopRequest('project-1'), true);
  assert.equal(otherWindow.snapshot().get('project-1').state, 'running');
  assert.deepEqual(otherWindow.requestStop('project-1'), { kind: 'requested' });
  assert.deepEqual(owner.consumeStopRequests(), ['project-1']);
  assert.deepEqual(owner.consumeStopRequests(), []);
  assert.equal(owner.release('project-1'), true);
  assert.equal(otherWindow.snapshot().has('project-1'), false);
});

test('recovers an exact owned process tree from persisted ownership details', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-recovery-'));
  const alive = new Set([101, 303]);
  const signals = [];
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);

  const stopped = await owner.terminateOwnedProcess('project-1', {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0 && alive.has(Math.abs(pid))) {
        return;
      }
      if (signal === 'SIGTERM') {
        alive.delete(Math.abs(pid));
        return;
      }
      const error = new Error('missing');
      error.code = 'ESRCH';
      throw error;
    },
    pollIntervalMs: 1
  });

  assert.equal(stopped, true);
  assert.deepEqual(signals[0], [-303, 'SIGTERM']);
  assert.equal(owner.release('project-1'), true);
});

test('does not recover a process tree owned by another VS Code host', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-recovery-other-'));
  const alive = new Set([101, 202, 303]);
  const isProcessAlive = (pid) => alive.has(pid);
  const owner = new ProcessOwnershipStore(directory, { pid: 101, platform: 'linux', isProcessAlive });
  const otherWindow = new ProcessOwnershipStore(directory, { pid: 202, platform: 'linux', isProcessAlive });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);

  assert.equal(await otherWindow.terminateOwnedProcess('project-1'), false);
  assert.equal(alive.has(303), true);
});

test('recovers the persisted owned process tree with taskkill on Windows', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-recovery-win-'));
  const alive = new Set([101, 303]);
  const calls = [];
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'win32',
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);

  const stopped = await owner.terminateOwnedProcess('project-1', {
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      process.nextTick(() => {
        alive.delete(303);
        child.emit('exit', 0);
      });
      return child;
    }
  });

  assert.equal(stopped, true);
  assert.deepEqual(calls[0], {
    command: 'taskkill.exe',
    args: ['/PID', '303', '/T', '/F'],
    options: {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    }
  });
});

test('fails safely when the launching host is gone but its child may still be running', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-uncertain-'));
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
