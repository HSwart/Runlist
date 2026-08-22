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
  projectStopStrategy,
  projectProcessSpawnOptions,
  recordStartedProcess,
  rollbackStartedProcess,
  shutdownTrackedProcesses,
  shouldRequestRemoteCustomStop,
  startExitFailed,
  terminateProcessTree,
  terminateTrackedProcess
} = require('../src/lifecycle/project-process');

test('uses the retrying atomic writer for lifecycle ownership state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lifecycle', 'project-process.js'), 'utf8');

  assert.match(source, /const \{ writeFileAtomically \} = require\('\.\.\/projects\/project-store'\)/);
  assert.match(source, /function writeJsonAtomically[\s\S]*writeFileAtomically\(filePath, JSON\.stringify\(value\)\)/);
});

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

test('uses the launch-time folder and stop command for the current process', () => {
  assert.deepEqual(projectStopStrategy({
    id: 'project-1',
    name: 'Project',
    folder: 'C:\\new-folder',
    stopCommand: 'new stop'
  }, {
    cwd: 'C:\\launch-folder',
    stopCommand: ''
  }), {
    id: 'project-1',
    name: 'Project',
    folder: 'C:\\launch-folder',
    stopCommand: ''
  });
});

test('uses launch-time temporary services when stopping from another window', () => {
  const project = {
    id: 'project-1',
    name: 'Project',
    folder: '/saved',
    services: [
      { name: 'web', port: 3000 },
      {
        name: 'api',
        port: 4000,
        portVariable: 'API_PORT',
        url: 'http://127.0.0.1:4000/health'
      }
    ]
  };

  const runtimeProject = projectStopStrategy(project, {
    portOverrides: [{
      serviceName: 'api',
      savedPort: 4000,
      port: 4001,
      variable: 'API_PORT'
    }]
  });

  assert.equal(runtimeProject.services[0].port, 3000);
  assert.deepEqual(runtimeProject.services[1], {
    name: 'api',
    port: 4001,
    portVariable: 'API_PORT',
    url: 'http://127.0.0.1:4001/health',
    savedPort: 4000,
    temporaryPort: true
  });
});

test('records child identity and launch-time Stop details in both coordination stores', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-record-'));
  const ownership = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: () => true,
    readProcessIdentity: async () => '303:original'
  });
  const { PortReservationStore } = require('../src/ports/port-gate');
  const reservations = new PortReservationStore(path.join(root, 'ports'), {
    pid: 101,
    isProcessAlive: () => true
  });
  const project = {
    id: 'project-1',
    folder: 'C:\\launch-folder',
    stopCommand: 'npm stop',
    services: [{ name: 'web', port: 4311, savedPort: 4310, temporaryPort: true }]
  };
  const child = { pid: 303 };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  ownership.reserve(project.id);
  reservations.reserve(project);
  const identity = await recordStartedProcess(
    ownership,
    reservations,
    project,
    child,
    {
      state: 'running',
      launchedAt: 1234,
      portOverrides: [{
        serviceName: 'web',
        savedPort: 4310,
        port: 4311,
        variable: 'PORT'
      }]
    }
  );

  assert.equal(identity, '303:original');
  assert.equal(await child.runlistIdentity, '303:original');
  assert.deepEqual(
    (({ childPid, childIdentity, cwd, stopCommand }) => ({
      childPid,
      childIdentity,
      cwd,
      stopCommand
    }))(ownership.snapshot().get(project.id)),
    {
      childPid: 303,
      childIdentity: '303:original',
      cwd: 'C:\\launch-folder',
      stopCommand: 'npm stop'
    }
  );
  const portLock = JSON.parse(fs.readFileSync(path.join(root, 'ports', 'port-4311.lock'), 'utf8'));
  assert.equal(portLock.childPid, 303);
  assert.equal(portLock.childIdentity, '303:original');
  assert.deepEqual(ownership.snapshot().get(project.id).portOverrides, [{
    serviceName: 'web',
    savedPort: 4310,
    port: 4311,
    variable: 'PORT'
  }]);
});

test('releases coordination only after a failed launch is confirmed terminated', async () => {
  const processes = new Map([['project-1', { pid: 303 }]]);
  const released = [];
  const ownership = { release: (id) => released.push(`ownership:${id}`) };
  const reservations = { release: (id) => released.push(`ports:${id}`) };

  const stopped = await rollbackStartedProcess(
    processes,
    'project-1',
    ownership,
    reservations,
    { terminateTrackedProcess: async (tracked, id) => tracked.delete(id) }
  );
  assert.deepEqual(stopped, { stopped: true });
  assert.deepEqual(released, ['ownership:project-1', 'ports:project-1']);

  processes.set('project-1', { pid: 304 });
  released.length = 0;
  const failed = await rollbackStartedProcess(
    processes,
    'project-1',
    ownership,
    reservations,
    { terminateTrackedProcess: async () => { throw new Error('still running'); } }
  );
  assert.equal(failed.stopped, false);
  assert.match(failed.error.message, /still running/);
  assert.deepEqual(released, []);
});

test('recovers an old corrupt ownership record but preserves a fresh partial write', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-corrupt-ownership-'));
  const probe = new ProcessOwnershipStore(directory, {
    pid: 101,
    invalidRecordGraceMs: 1000,
    isProcessAlive: () => false
  });
  const ownershipPath = probe.ownershipPath('project-1');
  fs.writeFileSync(ownershipPath, '{');
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(ownershipPath, old, old);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(probe.reserve('project-1'), undefined);
  probe.release('project-1');
  fs.writeFileSync(ownershipPath, '{');
  assert.deepEqual(probe.reserve('project-1'), { kind: 'uncertain' });
});

test('keeps ownership and port reservations until reload shutdown confirms the process stopped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-shutdown-'));
  const ownership = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: () => true
  });
  const { PortReservationStore } = require('../src/ports/port-gate');
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
  const { PortReservationStore } = require('../src/ports/port-gate');
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
    detached: true,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.deepEqual(customStopSpawnOptions('darwin'), {
    detached: true,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.deepEqual(customStopSpawnOptions('win32'), {
    detached: false,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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

test('accepts a POSIX process group that exits immediately before escalation', async () => {
  const signals = [];
  let livenessChecks = 0;
  await terminateProcessTree(507, {
    platform: 'darwin',
    terminateTimeoutMs: 0,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        livenessChecks += 1;
        if (livenessChecks === 1) {
          return;
        }
      }
      if (signal === 'SIGKILL' || signal === 0) {
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
    }
  });
  assert.deepEqual(signals, [[-507, 'SIGTERM'], [-507, 0], [-507, 'SIGKILL'], [-507, 0]]);
});

test('confirms an empty POSIX process group when signal-zero is denied after termination', async () => {
  const signals = [];
  await terminateProcessTree(506, {
    platform: 'darwin',
    kill: (pid, signal) => {
      if (signal === 0) {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      }
      signals.push([pid, signal]);
    },
    readProcessGroup: async () => []
  });

  assert.deepEqual(signals, [[-506, 'SIGTERM']]);
});

test('keeps a POSIX process group blocked when the EPERM fallback cannot verify it', async () => {
  await assert.rejects(terminateProcessTree(507, {
    platform: 'darwin',
    kill: () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    },
    readProcessGroup: async () => {
      throw new Error('ps unavailable');
    }
  }), /not permitted/);
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

test('treats a missing exited process as stopped when the platform terminator loses the race', async () => {
  const child = {
    pid: 609,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('609:original')
  };
  const processes = new Map([['project', child]]);

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readProcessIdentity: async () => undefined,
    spawnProcess: () => {
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 128));
      return taskkill;
    }
  }), true);
  assert.equal(processes.has('project'), false);
});

test('allows confirmed recovery to reconcile an exact tracked process that already disappeared', async () => {
  const child = {
    pid: 612,
    exitCode: null,
    signalCode: null,
    runlistIdentity: Promise.resolve('612:original')
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    allowMissing: true,
    platform: 'win32',
    readProcessIdentity: async () => undefined,
    spawnProcess: () => {
      terminationCalls += 1;
    }
  }), true);

  assert.equal(terminationCalls, 0);
  assert.equal(processes.has('project'), false);
});

test('does not treat an unreadable but live tracked process as missing during recovery', async () => {
  const child = {
    pid: 613,
    exitCode: null,
    signalCode: null,
    runlistIdentity: Promise.resolve('613:original')
  };
  const processes = new Map([['project', child]]);

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    allowMissing: true,
    isProcessAlive: () => true,
    platform: 'win32',
    readProcessIdentity: async () => undefined
  }), /could not verify.*process identity/i);

  assert.equal(processes.get('project'), child);
});

test('refuses to terminate a reused process identifier', async () => {
  const child = {
    pid: 610,
    exitCode: null,
    signalCode: null,
    runlistIdentity: Promise.resolve('610:original')
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readProcessIdentity: async () => '610:replacement',
    spawnProcess: () => {
      terminationCalls += 1;
    }
  }), /process identity changed/i);

  assert.equal(terminationCalls, 0);
  assert.equal(processes.get('project'), child);
});

test('revalidates tracked process identity immediately before tree termination', async () => {
  const child = {
    pid: 120,
    exitCode: null,
    signalCode: null,
    runlistIdentity: '120:first'
  };
  const processes = new Map([['project', child]]);
  let reads = 0;

  await assert.rejects(() => terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readProcessIdentity: async () => (++reads === 1 ? '120:first' : '120:replacement')
  }), /identity changed/i);
  assert.equal(reads, 2);
  assert.equal(processes.get('project'), child);
});

test('refuses a PID-only termination when process identity capture failed', async () => {
  const child = {
    pid: 611,
    exitCode: null,
    signalCode: null,
    runlistIdentity: Promise.resolve(undefined)
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    spawnProcess: () => {
      terminationCalls += 1;
    }
  }), /could not verify.*process identity/i);

  assert.equal(terminationCalls, 0);
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
  assert.equal(otherWindow.snapshot().get('project-1').state, 'stopping');
  assert.equal(owner.completeStopRequest('project-1'), true);
  assert.equal(otherWindow.snapshot().get('project-1').state, 'running');
  assert.equal(owner.release('project-1'), true);
  assert.equal(otherWindow.snapshot().has('project-1'), false);
});

test('retries a cross-window Stop when a stale request file is present', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-stale-stop-'));
  const alive = new Set([101, 202, 303]);
  const isProcessAlive = (pid) => alive.has(pid);
  const owner = new ProcessOwnershipStore(directory, { pid: 101, isProcessAlive });
  const requester = new ProcessOwnershipStore(directory, { pid: 202, isProcessAlive });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  fs.writeFileSync(owner.stopRequestPath('project-1'), JSON.stringify({
    projectId: 'project-1',
    requesterPid: 999,
    token: 'stale-token'
  }));

  assert.equal(requester.requestStop('project-1').kind, 'requested');
  assert.deepEqual(owner.consumeStopRequests(), ['project-1']);
});

test('expires a reused host PID after its ownership heartbeat stops', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-heartbeat-'));
  let now = 1000;
  const alive = new Set([101]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(directory, {
    pid: 202,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  assert.equal(observer.snapshot().get('project-1').ownerAvailable, true);

  now = 7001;
  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(observer.reserve('project-1'), undefined);
});

test('does not let a stale heartbeat overwrite a newer process owner', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-heartbeat-race-'));
  let now = 1000;
  let replaceOwner = false;
  let ownershipPath;
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => {
      if (replaceOwner) {
        replaceOwner = false;
        fs.writeFileSync(ownershipPath, JSON.stringify({
          projectId: 'project-1',
          hostPid: 202,
          platform: 'linux',
          state: 'starting',
          heartbeatAt: now,
          token: 'new-owner-token'
        }));
      }
      return now;
    },
    isProcessAlive: (pid) => [101, 202].includes(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  ownershipPath = owner.ownershipPath('project-1');
  now = 3000;
  replaceOwner = true;

  const snapshot = owner.snapshot().get('project-1');
  assert.equal(snapshot.token, 'new-owner-token');
  assert.equal(snapshot.hostPid, 202);
  assert.equal(JSON.parse(fs.readFileSync(ownershipPath, 'utf8')).token, 'new-owner-token');
});

test('recovers an ownership update marker only after its owner is gone', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-update-owner-'));
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => 1000,
    isProcessAlive: (pid) => pid === 101
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  fs.writeFileSync(`${owner.ownershipPath('project-1')}.update`, JSON.stringify({
    pid: 2147483647
  }));

  assert.equal(owner.setState('project-1', 'running'), true);
  assert.equal(owner.snapshot().get('project-1').state, 'running');
});

test('persists process identity and refuses recovered termination after PID reuse', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-identity-'));
  let childIdentity = '303:original';
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: () => true,
    readProcessIdentity: async () => childIdentity
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  assert.equal(await owner.trackProcessIdentity('project-1', 303), '303:original');
  assert.equal(owner.snapshot().get('project-1').childIdentity, '303:original');

  childIdentity = '303:replacement';
  await assert.rejects(
    owner.terminateOwnedProcess('project-1'),
    /process identity changed/i
  );
});

test('removes unavailable ownership when the persisted child PID identity was reused', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-reconcile-'));
  let now = 1000;
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => [101, 303].includes(pid),
    readProcessIdentity: async () => '303:original'
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    childIdentity: '303:original',
    identityRequired: true
  });
  now = 7001;
  const observer = new ProcessOwnershipStore(directory, {
    pid: 202,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => pid === 303,
    readProcessIdentity: async () => '303:replacement'
  });

  assert.equal(await observer.reconcileProcessIdentities(), 1);
  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(observer.reserve('project-1'), undefined);
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
