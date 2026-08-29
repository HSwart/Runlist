const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  detachedServiceIdentityDecision,
  markOwnedRuntimeDetached,
  ProcessOwnershipStore: RealProcessOwnershipStore,
  projectStopStrategy,
  projectProcessSpawnOptions,
  recordStartedProcess,
  rollbackStartedProcess,
  readProcessIdentity,
  readProcessIdentitySync,
  shutdownTrackedProcesses,
  shouldRequestRemoteCustomStop,
  spawnProjectCommand,
  startExitDetached,
  startExitFailed,
  terminateProcessTree,
  terminateTrackedProcess,
  transitionOwnedRuntimeState
} = require('../src/lifecycle/project-process');
const { reconcileDetachedProjectIds } = require('../src/lifecycle/project-status');
const { currentProcessIdentity } = require('../src/lifecycle/process-identity');
const { PortReservationStore: RealPortReservationStore } = require('../src/ports/port-gate');

test('updates reservation state only after the authoritative process transition succeeds', () => {
  const calls = [];
  const processOwnership = {
    setState: (projectId, state, details) => {
      calls.push(['process', projectId, state, details]);
      return false;
    }
  };
  const portReservations = {
    setState: (...args) => {
      calls.push(['ports', ...args]);
      return true;
    }
  };

  assert.deepEqual(transitionOwnedRuntimeState(
    processOwnership,
    portReservations,
    'project-1',
    'running',
    { readyAt: 1234 }
  ), { ownershipUpdated: false, reservationsUpdated: false });
  assert.deepEqual(calls, [
    ['process', 'project-1', 'running', { readyAt: 1234 }]
  ]);

  processOwnership.setState = (projectId, state, details) => {
    calls.push(['process', projectId, state, details]);
    return true;
  };
  assert.deepEqual(transitionOwnedRuntimeState(
    processOwnership,
    portReservations,
    'project-1',
    'not-ready'
  ), { ownershipUpdated: true, reservationsUpdated: true });
  assert.deepEqual(calls.slice(-2), [
    ['process', 'project-1', 'not-ready', {}],
    ['ports', 'project-1', 'not-ready']
  ]);
});

test('does not detach port reservations after process ownership changes generation', () => {
  let portsMarked = false;
  const processOwnership = { markDetached: () => false };
  const portReservations = {
    markDetached: () => {
      portsMarked = true;
      return true;
    }
  };
  const result = markOwnedRuntimeDetached(
    processOwnership,
    portReservations,
    'project-1'
  );

  assert.deepEqual(result, {
    ownershipUpdated: false,
    reservationsUpdated: false
  });
  assert.equal(portsMarked, false);

  processOwnership.markDetached = () => true;
  assert.deepEqual(markOwnedRuntimeDetached(
    processOwnership,
    portReservations,
    'project-1'
  ), {
    ownershipUpdated: true,
    reservationsUpdated: true
  });
  assert.equal(portsMarked, true);
});

function createOwnershipStore(directory, options = {}) {
  const pid = options.pid || process.pid;
  return new RealProcessOwnershipStore(directory, {
    ...options,
    platform: options.platform || 'linux',
    hostIdentity: options.hostIdentity || `test-host:${pid}`,
    readHostProcessIdentity: options.readHostProcessIdentity
      || ((hostPid) => `test-host:${hostPid}`)
  });
}

const ProcessOwnershipStore = createOwnershipStore;

function PortReservationStore(directory, options = {}) {
  const pid = options.pid || process.pid;
  return new RealPortReservationStore(directory, {
    ...options,
    platform: options.platform || 'linux',
    hostIdentity: options.hostIdentity || `test-host:${pid}`,
    readHostProcessIdentity: options.readHostProcessIdentity
      || ((hostPid) => `test-host:${hostPid}`)
  });
}

test('reports ownership acquisition, blocking identity, and stale recovery decisions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-ownership-diagnostics-'));
  const events = [];
  let ownerIdentity = 'test-host:101';
  const isProcessAlive = (pid) => [101, 202].includes(pid);
  const readHostProcessIdentity = (pid) => pid === 101 ? ownerIdentity : `test-host:${pid}`;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: ownerIdentity,
    isProcessAlive,
    readHostProcessIdentity,
    onDiagnostic: (event, details) => events.push({ event, ...details })
  });
  assert.equal(owner.reserve('project-1'), undefined);

  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: 'test-host:202',
    isProcessAlive,
    readHostProcessIdentity,
    hostIdentityCacheTtlMs: 0,
    onDiagnostic: (event, details) => events.push({ event, ...details })
  });
  assert.equal(observer.reserve('project-1').kind, 'owned');

  ownerIdentity = 'test-host:replacement';
  assert.equal(observer.reserve('project-1'), undefined);
  assert.deepEqual(events.map(({ event, projectId, reasonCode, identityDecision }) => ({
    event,
    projectId,
    reasonCode,
    identityDecision
  })), [
    {
      event: 'reserve.acquired',
      projectId: 'project-1',
      reasonCode: 'ownership-created',
      identityDecision: 'match'
    },
    {
      event: 'reserve.blocked',
      projectId: 'project-1',
      reasonCode: 'owner-available',
      identityDecision: 'match'
    },
    {
      event: 'reserve.stale-recovered',
      projectId: 'project-1',
      reasonCode: 'owner-identity-changed',
      identityDecision: 'mismatch'
    },
    {
      event: 'reserve.acquired',
      projectId: 'project-1',
      reasonCode: 'ownership-created',
      identityDecision: 'match'
    }
  ]);
});

function expectedDarwinIdentity(pid, startedAt, details) {
  const values = [
    'runlist-darwin-process',
    'v2',
    String(pid),
    startedAt,
    String(details.uid),
    String(details.processGroupId),
    String(details.sessionId).toLowerCase(),
    details.command
  ];
  const canonical = values
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('');
  return `${pid}:darwin:v2:${startedAt}:${crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')}`;
}

function testProcessIdentity(pid, platform) {
  return platform === 'darwin'
    ? expectedDarwinIdentity(pid, '2024-01-01T00:00:00', {
      uid: 501,
      processGroupId: pid,
      sessionId: pid,
      command: `/usr/local/bin/node process-${pid}.js`
    })
    : `${pid}:first`;
}

function changedCurrentProcessIdentity() {
  const identity = currentProcessIdentity({ allowRuntimeFallback: true });
  const final = identity.at(-1);
  return `${identity.slice(0, -1)}${final === '0' ? '1' : '0'}`;
}

test('uses the shared atomic-record updater for lifecycle ownership state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lifecycle', 'project-process.js'), 'utf8');

  assert.match(source, /createAtomicJsonRecordUpdater[\s\S]*require\('\.\/atomic-json-record'\)/);
  assert.match(source, /const OWNERSHIP_RECORDS = createAtomicJsonRecordUpdater\([\s\S]*writeFileAtomically/);
  assert.doesNotMatch(source, /function updateJsonRecord/);
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

test('requires consecutive identity-bound observations before clearing detached ownership', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-service-'));
  let now = 1000;
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => now,
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    services: [{ name: 'web', port: 4311 }]
  });
  const token = owner.snapshot().get('project-1').token;
  const original = [{ port: 4311, pid: 404, identity: '404:original' }];
  assert.equal(owner.recordDetachedServiceListeners('project-1', token, original), true);
  assert.equal(owner.markDetached('project-1'), true);
  const detached = owner.snapshot().get('project-1');
  const portGeneration = new Map([[4311, 'port-token']]);

  assert.equal(detachedServiceIdentityDecision(detached, {
    allOpen: true,
    anyOpen: true,
    openPorts: [4311]
  }, original), 'present');
  assert.equal(detachedServiceIdentityDecision(detached, {
    allOpen: true,
    anyOpen: true,
    openPorts: [4311]
  }, [{ port: 4311, pid: 505, identity: '505:replacement' }]), 'replaced');
  assert.equal(detachedServiceIdentityDecision({
    ...detached,
    detachedServiceListeners: undefined
  }, {
    allOpen: true,
    anyOpen: true,
    openPorts: [4311]
  }, [{ port: 4311, pid: 505, identity: '505:replacement' }]), 'uncertain');
  assert.equal(detachedServiceIdentityDecision(detached, {
    allOpen: false,
    anyOpen: false,
    openPorts: []
  }, []), 'missing');

  assert.equal(owner.claimDetachedServiceCleanup(
    'project-1', token, detached.detachedServiceListeners, 'missing', 2000
  ), false);
  assert.equal(owner.claimDetachedServiceCleanup(
    'project-1', 'replacement-token', detached.detachedServiceListeners, 'replaced', 2000
  ), false);
  now = 4000;
  assert.equal(owner.claimDetachedServiceCleanup(
    'project-1', token, detached.detachedServiceListeners, 'present', 2000
  ), false);
  now = 7000;
  assert.equal(owner.claimDetachedServiceCleanup(
    'project-1', token, detached.detachedServiceListeners, 'missing', 2000
  ), false);
  now = 10000;
  const claim = owner.claimDetachedServiceCleanup(
    'project-1', token, detached.detachedServiceListeners, 'missing', 2000, portGeneration
  );
  assert.equal(claim.token, token);
  assert.equal(owner.ownsDetachedServiceCleanupClaim('project-1', claim), true);
  assert.equal(owner.finishDetachedServiceCleanup('project-1', claim), true);
  assert.equal(owner.snapshot().has('project-1'), false);
});

test('serializes detached cleanup against another reconciler and custom Stop', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-claim-'));
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    services: [{ name: 'web', port: 4311 }]
  });
  const token = owner.snapshot().get('project-1').token;
  const listeners = [{ port: 4311, pid: 404, identity: '404:original' }];
  const generation = new Map([[4311, 'port-token']]);
  owner.recordDetachedServiceListeners('project-1', token, listeners);
  owner.markDetached('project-1');

  const claim = owner.claimDetachedServiceCleanup(
    'project-1', token, listeners, 'replaced', 2000, generation
  );
  assert.ok(claim.reclaimToken);
  assert.equal(owner.claimDetachedServiceCleanup(
    'project-1', token, listeners, 'replaced', 2000, generation
  ), false);
  assert.equal(owner.claimDetachedStop('project-1', token), false);
  assert.equal(owner.rollbackDetachedServiceCleanup('project-1', {
    ...claim,
    reclaimToken: 'different-reclaimer'
  }), false);
  assert.equal(owner.finishDetachedServiceCleanup('project-1', {
    ...claim,
    reclaimToken: 'different-reclaimer'
  }), false);
  assert.equal(owner.rollbackDetachedServiceCleanup('project-1', claim), true);

  const stopClaim = owner.claimDetachedStop('project-1', token);
  assert.equal(stopClaim.token, token);
  assert.equal(owner.claimDetachedServiceCleanup(
    'project-1', token, listeners, 'replaced', 2000, generation
  ), false);
  assert.equal(owner.snapshot().get('project-1').state, 'stopping');
});

test('requires an identity-bound dead detached child before clearing a legacy marker', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-legacy-'));
  let now = 1000;
  const alive = new Set([101, 306]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => now,
    isProcessAlive: (pid) => alive.has(pid),
    readProcessIdentity: () => {
      throw new Error('legacy cleanup must not infer identity from a reused PID');
    }
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const prepare = (projectId, port, childPid, childIdentity) => {
    owner.reserve(projectId);
    owner.setProcess(projectId, childPid, {
      services: [{ name: 'web', port }],
      ...(childIdentity === undefined ? {} : { childIdentity })
    });
    const token = owner.snapshot().get(projectId).token;
    owner.markDetached(projectId);
    return { token, generation: new Map([[port, `${projectId}-port-token`]]) };
  };
  const attempt = (projectId, token, generation) => {
    owner.claimDetachedServiceCleanup(projectId, token, undefined, 'missing', 100, generation);
    now += 200;
    return owner.claimDetachedServiceCleanup(
      projectId, token, undefined, 'missing', 100, generation
    );
  };

  const missing = prepare('missing-identity', 4311, 303);
  assert.equal(attempt('missing-identity', missing.token, missing.generation), false);

  const malformed = prepare('malformed-identity', 4312, 304, '304:valid');
  const malformedRecord = JSON.parse(fs.readFileSync(
    owner.ownershipPath('malformed-identity'),
    'utf8'
  ));
  fs.writeFileSync(owner.ownershipPath('malformed-identity'), JSON.stringify({
    ...malformedRecord,
    detachedChildIdentity: ' '
  }));
  assert.equal(attempt('malformed-identity', malformed.token, malformed.generation), false);

  const dead = prepare('dead-child', 4313, 305, '305:original');
  const deadClaim = attempt('dead-child', dead.token, dead.generation);
  assert.equal(deadClaim.token, dead.token);
  assert.equal(owner.finishDetachedServiceCleanup('dead-child', deadClaim), true);

  const live = prepare('live-reused-child', 4314, 306, '306:original');
  assert.equal(attempt('live-reused-child', live.token, live.generation), false);
  assert.equal(owner.snapshot().has('live-reused-child'), true);
});

test('persists detached launch state for another window after the owner exits', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-ownership-'));
  const alive = new Set([101, 303]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    cwd: 'C:\\launch-folder',
    readinessDeadline: 5000,
    services: [{ name: 'web', port: 4311 }],
    startCommand: 'start original',
    stopCommand: 'stop original'
  });
  assert.equal(owner.markDetached('project-1'), true);
  assert.equal(owner.setState('project-1', 'running', { readyAt: 4000 }), true);
  alive.delete(101);
  alive.delete(303);

  const detached = observer.snapshot().get('project-1');
  assert.equal(detached.detached, true);
  assert.equal(detached.state, 'running');
  assert.equal(detached.ownerAvailable, false);
  assert.equal(detached.processActive, false);
  assert.deepEqual(projectStopStrategy({
    id: 'project-1',
    folder: 'C:\\edited-folder',
    stopCommand: 'stop edited'
  }, detached), {
    id: 'project-1',
    folder: 'C:\\launch-folder',
    startCommand: 'start original',
    stopCommand: 'stop original',
    services: [{ name: 'web', port: 4311 }]
  });
  assert.equal(observer.reserve('project-1').kind, 'uncertain');

  assert.equal(observer.releaseShared('project-1', detached.token), true);
  assert.equal(observer.snapshot().has('project-1'), false);
});

test('rejects a delayed process update after ownership becomes detached', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-process-update-'));
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => pid === 101 || pid === 303
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, { childIdentity: '303:original' });
  assert.equal(owner.markDetached('project-1'), true);
  assert.equal(owner.setProcess('project-1', 404, {
    childIdentity: '404:delayed',
    state: 'running'
  }), false);

  const snapshot = owner.snapshot().get('project-1');
  assert.equal(snapshot.detached, true);
  assert.equal(snapshot.childPid, undefined);
  assert.equal(snapshot.childIdentity, undefined);
  assert.equal(snapshot.state, 'detached');
});

test('claims detached custom Stop once across windows and reconciles local detached state after shared cleanup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-stop-claim-'));
  const alive = new Set([101, 202, 303]);
  const owner = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const ownerPorts = new PortReservationStore(path.join(root, 'ports'), {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observerPorts = new PortReservationStore(path.join(root, 'ports'), {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const project = {
    id: 'project-1',
    services: [{ name: 'web', port: 4314 }]
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  owner.reserve(project.id);
  owner.setProcess(project.id, 303, { stopCommand: 'npm stop' });
  ownerPorts.reserve(project);
  owner.markDetached(project.id);
  ownerPorts.markDetached(project.id);
  const token = owner.snapshot().get(project.id).token;
  const generation = observerPorts.captureShared(project.id);

  assert.equal(owner.claimDetachedStop(project.id, token).token, token);
  assert.equal(observer.snapshot().get(project.id).state, 'stopping');
  assert.equal(observer.claimDetachedStop(project.id, token), false);

  assert.equal(observerPorts.releaseShared(project.id, generation), true);
  assert.equal(observer.snapshot().has(project.id), true);
  assert.equal(observer.releaseShared(project.id, token), true);
  assert.equal(owner.releaseShared(project.id, token), false);
  assert.deepEqual(
    [...reconcileDetachedProjectIds(
      new Set([project.id]),
      owner.snapshot(),
      observerPorts.snapshot()
    )],
    []
  );
});

test('rolls back a failed detached Stop claim for retry and protects a replacement token', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-stop-rollback-'));
  const alive = new Set([101, 202, 303]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, { stopCommand: 'npm stop' });
  owner.markDetached('project-1');
  owner.setState('project-1', 'not-responding');
  const token = owner.snapshot().get('project-1').token;

  const firstClaim = observer.claimDetachedStop('project-1', token);
  assert.equal(firstClaim.token, token);
  assert.equal(firstClaim.priorState, 'not-responding');
  assert.equal(observer.rollbackDetachedStop('project-1', firstClaim.token, firstClaim.priorState), true);
  assert.equal(observer.snapshot().get('project-1').state, 'not-responding');
  const retryClaim = owner.claimDetachedStop('project-1', token);
  assert.equal(retryClaim.token, token);
  assert.equal(owner.rollbackDetachedStop('project-1', 'wrong-token', retryClaim.priorState), false);
  assert.equal(owner.snapshot().get('project-1').state, 'stopping');

  assert.equal(owner.releaseShared('project-1', token), true);
  owner.reserve('project-1');
  owner.markDetached('project-1');
  const replacement = owner.snapshot().get('project-1');
  assert.notEqual(replacement.token, token);
  assert.equal(observer.rollbackDetachedStop('project-1', token), false);
  assert.equal(owner.snapshot().get('project-1').token, replacement.token);
  assert.equal(owner.snapshot().get('project-1').state, 'detached');
});

test('does not let stale detached Stop cleanup release replacement ownership or ports', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-stop-replacement-'));
  const alive = new Set([101, 202, 303]);
  const owner = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const ownerPorts = new PortReservationStore(path.join(root, 'ports'), {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observerPorts = new PortReservationStore(path.join(root, 'ports'), {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const project = { id: 'project-1', services: [{ name: 'web', port: 4316 }] };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  owner.reserve(project.id);
  owner.setProcess(project.id, 303, { stopCommand: 'npm stop' });
  owner.markDetached(project.id);
  ownerPorts.reserve(project);
  ownerPorts.markDetached(project.id);
  const oldToken = owner.snapshot().get(project.id).token;
  const oldGeneration = observerPorts.captureShared(project.id);
  assert.equal(observer.claimDetachedStop(project.id, oldToken).token, oldToken);

  assert.equal(observer.releaseShared(project.id, oldToken), true);
  assert.equal(observerPorts.releaseShared(project.id, oldGeneration), true);
  observer.reserve(project.id);
  observer.markDetached(project.id);
  observerPorts.reserve(project);
  observerPorts.markDetached(project.id);
  const replacement = observer.snapshot().get(project.id);

  assert.equal(observer.releaseShared(project.id, oldToken), false);
  assert.equal(observerPorts.releaseShared(project.id, oldGeneration), false);
  assert.equal(observer.snapshot().get(project.id).token, replacement.token);
  assert.equal(observerPorts.snapshot().get(project.id), 'detached');
});

test('keeps replacement ownership after stale force-close success cleanup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-force-close-ownership-'));
  const alive = new Set([101, 202, 303]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303, { stopCommand: 'npm stop' });
  owner.markDetached('project-1');
  const capturedToken = owner.snapshot().get('project-1').token;
  assert.equal(observer.releaseShared('project-1', capturedToken), true);
  observer.reserve('project-1');
  observer.markDetached('project-1');
  const replacement = observer.snapshot().get('project-1');

  assert.equal(observer.releaseShared('project-1', capturedToken), false);
  assert.equal(observer.snapshot().get('project-1').token, replacement.token);
  assert.equal(observer.snapshot().get('project-1').state, 'detached');
});

test('records child identity and launch-time Stop details in both coordination stores', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-record-'));
  const ownership = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: () => true,
    readProcessIdentity: async () => '303:original'
  });
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
  const supervisorMessages = [];
  const child = {
    pid: 303,
    connected: true,
    send(message, callback) {
      supervisorMessages.push(message);
      callback?.();
    },
    disconnect() {
      this.connected = false;
    }
  };
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
    },
    { platform: 'linux' }
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
  assert.deepEqual(supervisorMessages, [{ type: 'runlistIdentityCaptured' }]);
  assert.equal(child.connected, false);
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

test('keeps the Windows supervisor until its initial owned tree is captured', async () => {
  let resolveTree;
  const tree = new Promise((resolve) => {
    resolveTree = resolve;
  });
  const messages = [];
  const child = {
    pid: 304,
    connected: true,
    send(message) {
      messages.push(message);
    },
    disconnect() {
      this.connected = false;
    }
  };
  const ownership = {
    trackProcessIdentity: async () => '304:100',
    setProcess: () => true
  };
  const reservations = {
    capture: () => 'generation',
    setProcess: () => 0
  };

  const recorded = recordStartedProcess(
    ownership,
    reservations,
    { id: 'project', folder: 'C:\\project', startCommand: 'npm start', services: [] },
    child,
    {},
    {
      platform: 'win32',
      processTreeSettleMs: 0,
      readOwnedProcessTree: async () => tree
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, []);
  assert.equal(child.connected, true);

  resolveTree([
    { pid: 304, parentPid: 1, identity: '304:100' },
    { pid: 305, parentPid: 304, identity: '305:110' }
  ]);
  assert.equal(await recorded, '304:100');
  assert.deepEqual(await child.runlistProcessTree, [
    { pid: 304, parentPid: 1, identity: '304:100' },
    { pid: 305, parentPid: 304, identity: '305:110' }
  ]);
  assert.deepEqual(messages, [{ type: 'runlistIdentityCaptured' }]);
  assert.equal(child.connected, false);
});

test('fails Windows Start closed when its initial owned tree cannot be verified', async () => {
  const messages = [];
  const child = {
    pid: 306,
    connected: true,
    send(message) {
      messages.push(message);
    },
    disconnect() {
      this.connected = false;
    }
  };
  const ownership = {
    trackProcessIdentity: async () => '306:100',
    setProcess: () => true
  };
  const reservations = {
    capture: () => 'generation',
    setProcess: () => 0
  };

  await assert.rejects(
    recordStartedProcess(
      ownership,
      reservations,
      { id: 'project', folder: 'C:\\project', startCommand: 'npm start', services: [] },
      child,
      {},
      {
        platform: 'win32',
        processTreeSettleMs: 0,
        readOwnedProcessTree: async () => []
      }
    ),
    /could not verify the launched Windows process tree/
  );
  assert.deepEqual(messages, [{ type: 'runlistIdentityCaptured' }]);
  assert.equal(child.connected, false);
});

test('keeps a Windows Start when CIM tree inspection fails but the root identity still matches', async () => {
  const messages = [];
  const child = {
    pid: 306,
    connected: true,
    send(message) {
      messages.push(message);
    },
    disconnect() {
      this.connected = false;
    }
  };
  const ownership = {
    trackProcessIdentity: async () => '306:100',
    setProcess: () => true
  };
  const reservations = {
    capture: () => 'generation',
    setProcess: () => 0
  };

  await recordStartedProcess(
    ownership,
    reservations,
    { id: 'project', folder: 'C:\\project', startCommand: 'npm start', services: [] },
    child,
    {},
    {
      platform: 'win32',
      processTreeSettleMs: 0,
      readOwnedProcessTree: async () => [{
        pid: 306,
        parentPid: 0,
        identity: '306:100',
        cpuSeconds: 0.1,
        memoryBytes: 1024,
        treeIncomplete: true
      }]
    }
  );
  assert.equal(child.runlistProcessTreeDegraded, true);
  assert.deepEqual(messages, [{ type: 'runlistIdentityCaptured' }]);
  assert.equal(child.connected, false);
  assert.deepEqual(await child.runlistProcessTree, [{
    pid: 306,
    parentPid: 0,
    identity: '306:100',
    cpuSeconds: 0.1,
    memoryBytes: 1024,
    treeIncomplete: true
  }]);
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

test('recovers a shared ownership update marker after its host PID is reused', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-reused-update-owner-'));
  const ownership = new ProcessOwnershipStore(directory, { platform: 'linux' });
  const ownershipPath = ownership.ownershipPath('project-1');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(ownership.reserve('project-1'), undefined);
  fs.writeFileSync(`${ownershipPath}.update`, JSON.stringify({
    pid: process.pid,
    processIdentity: changedCurrentProcessIdentity()
  }));

  assert.equal(ownership.release('project-1'), true);
  assert.equal(fs.existsSync(ownershipPath), false);
  assert.equal(fs.existsSync(`${ownershipPath}.update`), false);
});

test('keeps ownership and port reservations until reload shutdown confirms the process stopped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-shutdown-'));
  const ownership = new ProcessOwnershipStore(path.join(root, 'ownership'), {
    pid: 101,
    isProcessAlive: () => true
  });
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

test('gives POSIX process-group ownership probes enough time under load', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lifecycle', 'project-process.js'), 'utf8');
  assert.match(source, /const PROCESS_GROUP_PROBE_TIMEOUT_MS = 10000;/);
  assert.match(source, /processGroupProbeTimeoutMs \?\? PROCESS_GROUP_PROBE_TIMEOUT_MS/);
});

test('keeps the Darwin process-group root behind an exec-stable supervisor', () => {
  const calls = [];
  const child = {};
  const result = spawnProjectCommand('exec node server.js', {
    cwd: '/project',
    env: { PORT: '4310' },
    execPath: '/runtime/node',
    platform: 'darwin',
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    supervisorPath: '/extension/process-supervisor.js'
  });

  assert.equal(result, child);
  assert.deepEqual(calls, [[
    '/runtime/node',
    ['/extension/process-supervisor.js', 'exec node server.js'],
    {
      cwd: '/project',
      detached: true,
      env: { PORT: '4310' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ]]);
});

test('keeps the Windows process-tree root behind an identity-gated supervisor', () => {
  const calls = [];
  const child = {};
  const result = spawnProjectCommand('node failure.js', {
    cwd: 'C:\\project',
    env: { PORT: '4310' },
    execPath: 'C:\\runtime\\node.exe',
    platform: 'win32',
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    supervisorPath: 'C:\\extension\\process-supervisor.js'
  });

  assert.equal(result, child);
  assert.deepEqual(calls, [[
    'C:\\runtime\\node.exe',
    ['C:\\extension\\process-supervisor.js', 'node failure.js'],
    {
      cwd: 'C:\\project',
      detached: false,
      env: { PORT: '4310' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    }
  ]]);
});

test('holds a completed supervised command until process identity capture is released', async (t) => {
  const supervisor = require('node:child_process').spawn(process.execPath, [
    path.join(__dirname, '..', 'src', 'lifecycle', 'process-supervisor.js'),
    `"${process.execPath}" -e "process.stdout.write('finished\\n');process.exit(7)"`
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(() => {
    if (supervisor.exitCode == null && supervisor.signalCode == null) {
      supervisor.kill('SIGKILL');
    }
  });

  await once(supervisor.stdout, 'data');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(supervisor.exitCode, null);

  supervisor.send({ type: 'runlistIdentityCaptured' });
  const [code, signal] = await once(supervisor, 'exit');
  assert.equal(code, 7);
  assert.equal(signal, null);
});

test('releases a completed supervisor when its identity owner disconnects', async (t) => {
  const supervisor = require('node:child_process').spawn(process.execPath, [
    path.join(__dirname, '..', 'src', 'lifecycle', 'process-supervisor.js'),
    `"${process.execPath}" -e "process.stdout.write('finished\\n')"`
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(() => {
    if (supervisor.exitCode == null && supervisor.signalCode == null) {
      supervisor.kill('SIGKILL');
    }
  });

  await once(supervisor.stdout, 'data');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(supervisor.exitCode, null);

  supervisor.disconnect();
  const [code, signal] = await once(supervisor, 'exit');
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('keeps a fast Windows launch alive through the complete identity-recording handshake', async (t) => {
  let resolveIdentity;
  const identity = new Promise((resolve) => {
    resolveIdentity = resolve;
  });
  const child = spawnProjectCommand(
    `"${process.execPath}" -e "process.stdout.write('finished\\n');process.exit(7)"`,
    {
      platform: 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
    }
  });
  const ownership = {
    trackProcessIdentity: () => identity,
    setProcess: () => true
  };
  const reservations = {
    capture: () => 'generation',
    setProcess: () => 0
  };
  const project = {
    id: 'fast-windows-launch',
    folder: process.cwd(),
    startCommand: 'fast failure',
    services: []
  };
  const recordedIdentity = recordStartedProcess(
    ownership,
    reservations,
    project,
    child,
    {},
    {
      platform: 'win32',
      processTreeSettleMs: 0,
      readOwnedProcessTree: async () => [{
        pid: child.pid,
        parentPid: process.pid,
        identity: await identity
      }]
    }
  );

  await once(child.stdout, 'data');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);

  resolveIdentity(`${child.pid}:638912345678901234`);
  assert.equal(await recordedIdentity, `${child.pid}:638912345678901234`);
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 7);
  assert.equal(signal, null);
});

test('preserves existing shell launch behavior on Linux', () => {
  const calls = [];
  spawnProjectCommand('npm run dev', {
    platform: 'linux',
    spawnProcess: (...args) => {
      calls.push(args);
      return {};
    },
    stdio: 'pipe'
  });

  assert.deepEqual(calls, [[
    'npm run dev',
    { detached: true, shell: true, stdio: 'pipe' }
  ]]);
});

test('spawns Compose argv without a shell on Linux and through the supervisor on macOS/Windows', () => {
  const argv = {
    file: '/usr/local/bin/docker',
    args: ['compose', '-f', '/tmp/my stack/compose.yaml', 'up', 'web']
  };

  const linuxCalls = [];
  spawnProjectCommand('docker compose up web', {
    platform: 'linux',
    argv,
    spawnProcess: (...args) => {
      linuxCalls.push(args);
      return {};
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.deepEqual(linuxCalls, [[
    '/usr/local/bin/docker',
    ['compose', '-f', '/tmp/my stack/compose.yaml', 'up', 'web'],
    { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
  ]]);

  const darwinCalls = [];
  spawnProjectCommand('docker compose up web', {
    cwd: '/project',
    env: { PATH: '/usr/bin' },
    execPath: '/runtime/node',
    platform: 'darwin',
    argv,
    spawnProcess: (...args) => {
      darwinCalls.push(args);
      return {};
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    supervisorPath: '/extension/process-supervisor.js'
  });
  assert.deepEqual(darwinCalls, [[
    '/runtime/node',
    [
      '/extension/process-supervisor.js',
      '--',
      '/usr/local/bin/docker',
      'compose',
      '-f',
      '/tmp/my stack/compose.yaml',
      'up',
      'web'
    ],
    {
      cwd: '/project',
      detached: true,
      env: { PATH: '/usr/bin' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ]]);

  const windowsCalls = [];
  spawnProjectCommand('docker compose up web', {
    cwd: 'C:\\project',
    execPath: 'C:\\runtime\\node.exe',
    platform: 'win32',
    argv: {
      file: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      args: ['compose', '-f', 'C:\\my stack\\compose.yaml', 'stop', 'web']
    },
    spawnProcess: (...args) => {
      windowsCalls.push(args);
      return {};
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    supervisorPath: 'C:\\extension\\process-supervisor.js'
  });
  assert.deepEqual(windowsCalls, [[
    'C:\\runtime\\node.exe',
    [
      'C:\\extension\\process-supervisor.js',
      '--',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      'compose',
      '-f',
      'C:\\my stack\\compose.yaml',
      'stop',
      'web'
    ],
    {
      cwd: 'C:\\project',
      detached: false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    }
  ]]);
});

test('holds a completed argv-supervised command until process identity capture is released', async (t) => {
  const supervisor = require('node:child_process').spawn(process.execPath, [
    path.join(__dirname, '..', 'src', 'lifecycle', 'process-supervisor.js'),
    '--',
    process.execPath,
    '-e',
    "process.stdout.write('finished\\n');process.exit(7)"
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(() => {
    if (supervisor.exitCode == null && supervisor.signalCode == null) {
      supervisor.kill('SIGKILL');
    }
  });

  await once(supervisor.stdout, 'data');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(supervisor.exitCode, null);

  supervisor.send({ type: 'runlistIdentityCaptured' });
  const [code, signal] = await once(supervisor, 'exit');
  assert.equal(code, 7);
  assert.equal(signal, null);
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
  assert.equal(startExitFailed({
    code: 0,
    hasCustomStop: false,
    hasServices: true,
    stoppedIntentionally: false
  }), true);
  assert.equal(startExitFailed({
    code: 0,
    hasCustomStop: true,
    hasServices: true,
    stoppedIntentionally: false
  }), false);
  assert.equal(startExitFailed({ code: 1, hasServices: false, stoppedIntentionally: false }), true);
  assert.equal(startExitFailed({ code: 0, hasServices: false, stoppedIntentionally: false }), false);
  assert.equal(startExitFailed({ code: 1, hasServices: true, stoppedIntentionally: true }), false);
  assert.equal(startExitDetached({
    code: 0,
    hasCustomStop: true,
    hasServices: true,
    stoppedIntentionally: false
  }), true);
  assert.equal(startExitDetached({
    code: 0,
    hasCustomStop: false,
    hasServices: true,
    stoppedIntentionally: false
  }), false);
});

test('keeps detached ownership on the custom-stop path for local and cross-window stops', () => {
  const project = { stopCommand: 'docker compose down' };
  const detachedOwner = {
    detached: true,
    ownerAvailable: true,
    processActive: false
  };

  assert.equal(shouldRequestRemoteCustomStop(project, detachedOwner, false, true), false);
  assert.equal(shouldRequestRemoteCustomStop(project, detachedOwner, false, false), false);
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

test('withholds POSIX escalation when the root identity changes during the grace wait', async () => {
  const signals = [];
  let identityReads = 0;
  let groupAlive = true;
  await assert.rejects(terminateProcessTree(508, {
    platform: 'linux',
    expectedIdentity: '508:first',
    terminateTimeoutMs: 0,
    readProcessIdentity: async () => (++identityReads === 1 ? '508:first' : '508:replacement'),
    readProcessGroup: async () => [508, 509],
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
  }), /identity changed/i);

  assert.equal(identityReads, 2);
  assert.deepEqual(signals, [[-508, 'SIGTERM']]);
});

test('does not escalate a POSIX group that exits during the grace wait', async () => {
  const signals = [];
  let livenessChecks = 0;
  const identity = testProcessIdentity(509, 'darwin');
  await terminateProcessTree(509, {
    platform: 'darwin',
    expectedIdentity: identity,
    terminateTimeoutMs: 0,
    readProcessIdentity: async () => identity,
    readProcessGroup: async () => [],
    kill: (pid, signal) => {
      if (signal === 0) {
        livenessChecks += 1;
        if (livenessChecks === 1) {
          return;
        }
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, [[-509, 'SIGTERM']]);
});

test('withholds POSIX escalation when identity or group membership is unverifiable', async (t) => {
  for (const [name, escalatedIdentity, members, message] of [
    ['missing identity', undefined, [510], /could not verify.*identity/i],
    ['malformed identity', ' 510:first ', [510], /could not verify.*identity/i],
    ['changed group membership', '510:first', [511], /process group changed/i]
  ]) {
    await t.test(name, async () => {
      const signals = [];
      let identityReads = 0;
      await assert.rejects(terminateProcessTree(510, {
        platform: 'linux',
        expectedIdentity: '510:first',
        terminateTimeoutMs: 0,
        readProcessIdentity: async () => (++identityReads === 1 ? '510:first' : escalatedIdentity),
        readProcessGroup: async () => members,
        kill: (pid, signal) => {
          if (signal === 0) {
            return;
          }
          signals.push([pid, signal]);
        }
      }), message);
      assert.deepEqual(signals, [[-510, 'SIGTERM']]);
    });
  }
});

test('escalates a still-matching POSIX root and process group', async (t) => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    await t.test(platform, async () => {
      const signals = [];
      let groupAlive = true;
      const identity = testProcessIdentity(512, platform);
      await terminateProcessTree(512, {
        platform,
        expectedIdentity: identity,
        terminateTimeoutMs: 0,
        readProcessIdentity: async () => identity,
        readProcessGroup: async () => [512, 513],
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
      assert.deepEqual(signals, [[-512, 'SIGTERM'], [-512, 'SIGKILL']]);
    });
  }
});

test('enumerates exact PID and PGID pairs before POSIX escalation', async (t) => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    await t.test(platform, async () => {
      const calls = [];
      const signals = [];
      let groupAlive = true;
      const identity = testProcessIdentity(514, platform);
      await terminateProcessTree(514, {
        platform,
        expectedIdentity: identity,
        terminateTimeoutMs: 0,
        readProcessIdentity: async () => identity,
        execFile: (command, args, options, callback) => {
          calls.push({ command, args, options });
          callback(null, '514 514\n515 514\n516 999\n');
        },
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
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'ps');
      assert.deepEqual(calls[0].args, ['-axo', 'pid=,pgid=']);
      assert.equal(calls[0].options.encoding, 'utf8');
      assert.equal(calls[0].options.windowsHide, true);
      assert.deepEqual(signals, [[-514, 'SIGTERM'], [-514, 'SIGKILL']]);
    });
  }
});

test('fails closed on malformed, ambiguous, missing-root, and failed POSIX group listings', async (t) => {
  for (const [name, output, commandError] of [
    ['malformed row', '517 517\nnot-a-pair\n', undefined],
    ['nonpositive pair', '517 517\n0 517\n', undefined],
    ['ambiguous PID', '517 517\n517 999\n', undefined],
    ['missing root', '518 517\n', undefined],
    ['command error', '', Object.assign(new Error('ps failed'), { code: 1 })]
  ]) {
    await t.test(name, async () => {
      const signals = [];
      await assert.rejects(terminateProcessTree(517, {
        platform: 'linux',
        expectedIdentity: '517:first',
        terminateTimeoutMs: 0,
        readProcessIdentity: async () => '517:first',
        execFile: (command, args, options, callback) => callback(commandError, output),
        kill: (pid, signal) => {
          if (signal === 0) {
            return;
          }
          signals.push([pid, signal]);
        }
      }), /process group/i);
      assert.deepEqual(signals, [[-517, 'SIGTERM']]);
    });
  }
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

test('waits for a descendant-only POSIX group when signal-zero is denied after root exit', async () => {
  const signals = [];
  let livenessChecks = 0;
  await terminateProcessTree(506, {
    platform: 'darwin',
    pollIntervalMs: 0,
    execFile: (command, args, options, callback) => callback(null, '700 506\n'),
    kill: (pid, signal) => {
      if (signal === 0) {
        livenessChecks += 1;
        throw Object.assign(new Error(livenessChecks === 1 ? 'not permitted' : 'not found'), {
          code: livenessChecks === 1 ? 'EPERM' : 'ESRCH'
        });
      }
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, [[-506, 'SIGTERM']]);
  assert.equal(livenessChecks, 3);
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

test('does not hide a process-group permission failure after the tracked root exits', async () => {
  const child = { pid: 607, exitCode: null, signalCode: null };
  const processes = new Map([['project', child]]);

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'darwin',
    kill: () => {
      child.exitCode = 0;
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }
  }), /not permitted/);
  assert.equal(processes.get('project'), child);
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
  assert.equal(processes.get('project'), child);
});

test('keeps ownership when Windows cannot confirm cleanup after the root exits', async () => {
  const child = {
    pid: 609,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('609:100')
  };
  const processes = new Map([['project', child]]);

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    isProcessAlive: () => false,
    readProcessIdentity: async () => undefined,
    readOwnedProcessTree: async () => { throw new Error('process query unavailable'); }
  }), /process query unavailable/);
  assert.equal(processes.get('project'), child);
});

test('terminates identity-checked Windows descendants after their tracked root exits', async () => {
  const child = {
    pid: 615,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('615:100')
  };
  const processes = new Map([['project', child]]);
  const calls = [];

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => [
      { pid: 700, parentPid: 615, identity: '700:110' },
      { pid: 701, parentPid: 700, identity: '701:120' },
      { pid: 702, parentPid: 615, identity: '702:90' }
    ],
    readProcessIdentity: async (pid) => (pid === 700 ? '700:110' : undefined),
    spawnProcess: (command, args) => {
      calls.push([command, args]);
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 0));
      return taskkill;
    }
  }), true);

  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '700', '/T', '/F']]]);
  assert.equal(processes.has('project'), false);
});

test('terminates an exact orphan from the captured Windows tree after every parent exits', async () => {
  const child = {
    pid: 615,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('615:100'),
    runlistProcessTree: Promise.resolve([
      { pid: 615, parentPid: 1, identity: '615:100' },
      { pid: 700, parentPid: 615, identity: '700:110' },
      { pid: 701, parentPid: 700, identity: '701:120' },
      { pid: 702, parentPid: 701, identity: '702:130' }
    ])
  };
  const processes = new Map([['project', child]]);
  const calls = [];

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => [],
    readProcessIdentity: async (pid) => (pid === 702 ? '702:130' : undefined),
    spawnProcess: (command, args) => {
      calls.push([command, args]);
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 0));
      return taskkill;
    }
  }), true);

  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '702', '/T', '/F']]]);
  assert.equal(processes.has('project'), false);
});

test('checks captured Windows orphans even when terminating the visible root succeeds', async () => {
  const child = {
    pid: 615,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('615:100'),
    runlistProcessTree: Promise.resolve([
      { pid: 615, parentPid: 1, identity: '615:100' },
      { pid: 700, parentPid: 615, identity: '700:110' },
      { pid: 702, parentPid: 700, identity: '702:120' }
    ])
  };
  const processes = new Map([['project', child]]);
  const calls = [];
  let treeReads = 0;

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => (++treeReads === 1
      ? [{ pid: 615, parentPid: 1, identity: '615:100' }]
      : []),
    readProcessIdentity: async (pid) => ({
      615: '615:100',
      702: '702:120'
    })[pid],
    spawnProcess: (command, args) => {
      calls.push([command, args]);
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 0));
      return taskkill;
    }
  }), true);

  assert.deepEqual(calls, [
    ['taskkill.exe', ['/PID', '615', '/T', '/F']],
    ['taskkill.exe', ['/PID', '702', '/T', '/F']]
  ]);
  assert.equal(processes.has('project'), false);
});

test('terminates an exact Windows root that remains visible after its exit event', async () => {
  const child = {
    pid: 624,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: Promise.resolve('624:100')
  };
  const processes = new Map([['project', child]]);
  const calls = [];

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => [{
      pid: 624,
      parentPid: 1,
      identity: '624:100'
    }],
    readProcessIdentity: async () => '624:100',
    spawnProcess: (command, args) => {
      calls.push([command, args]);
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 0));
      return taskkill;
    }
  }), true);

  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '624', '/T', '/F']]]);
  assert.equal(processes.has('project'), false);
});

test('reconciles an exited Windows root that disappears during exact revalidation', async () => {
  const child = {
    pid: 625,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: Promise.resolve('625:100')
  };
  const processes = new Map([['project', child]]);
  let identityReads = 0;
  let treeReads = 0;

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => (++treeReads === 1 ? [{
      pid: 625,
      parentPid: 1,
      identity: '625:100'
    }] : []),
    readProcessIdentity: async () => (++identityReads === 1 ? '625:100' : undefined),
    spawnProcess: () => {
      throw new Error('taskkill must not run after the exact root disappears');
    }
  }), true);

  assert.equal(identityReads, 2);
  assert.equal(treeReads, 2);
  assert.equal(processes.has('project'), false);
});

test('stops an exact Windows descendant when the exited root disappears during revalidation', async () => {
  const child = {
    pid: 626,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: Promise.resolve('626:100')
  };
  const processes = new Map([['project', child]]);
  const calls = [];
  let rootIdentityReads = 0;
  let treeReads = 0;

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => (++treeReads === 1 ? [{
      pid: 626,
      parentPid: 1,
      identity: '626:100'
    }] : [{
      pid: 700,
      parentPid: 626,
      identity: '700:110'
    }]),
    readProcessIdentity: async (pid) => {
      if (pid === 626) {
        return ++rootIdentityReads === 1 ? '626:100' : undefined;
      }
      return pid === 700 ? '700:110' : undefined;
    },
    spawnProcess: (command, args) => {
      calls.push([command, args]);
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 0));
      return taskkill;
    }
  }), true);

  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '700', '/T', '/F']]]);
  assert.equal(processes.has('project'), false);
});

test('refuses exited-root cleanup when the Windows root PID was reused', async () => {
  const child = {
    pid: 616,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('616:100')
  };
  const processes = new Map([['project', child]]);

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readProcessIdentity: async () => undefined,
    readOwnedProcessTree: async () => [{
      pid: 616,
      parentPid: 1,
      identity: '616:200'
    }]
  }), /process identity changed/);
  assert.equal(processes.get('project'), child);
});

test('terminates surviving POSIX descendants after their tracked root exits', async () => {
  const child = {
    pid: 614,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve('614:original')
  };
  const processes = new Map([['project', child]]);
  const signals = [];
  let groupAlive = true;

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'linux',
    readProcessIdentity: async () => '614:original',
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
  assert.deepEqual(signals, [[-614, 'SIGTERM']]);
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
    isProcessAlive: () => false,
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

test('does not signal when termination identity is missing', async () => {
  const signals = [];
  await assert.rejects(terminateProcessTree(614, {
    platform: 'linux',
    expectedIdentity: undefined,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
    }
  }), /could not verify.*process identity/i);
  assert.deepEqual(signals, []);
});

test('terminates normally when the expected identity is unchanged', async () => {
  const signals = [];
  await terminateProcessTree(615, {
    platform: 'linux',
    expectedIdentity: '615:first',
    readProcessIdentity: async () => '615:first',
    kill: (pid, signal) => {
      if (signal === 0) {
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
      signals.push([pid, signal]);
    }
  });
  assert.deepEqual(signals, [[-615, 'SIGTERM']]);
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

test('fails closed when an exited tracked child has no identity but its PID is live', async () => {
  const child = {
    pid: 616,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve(undefined)
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    readOwnedProcessTree: async () => [{
      pid: 616,
      parentPid: 1,
      identity: '616:replacement'
    }],
    spawnProcess: () => {
      terminationCalls += 1;
      const taskkill = new EventEmitter();
      taskkill.stderr = new EventEmitter();
      taskkill.stderr.setEncoding = () => {};
      process.nextTick(() => taskkill.emit('exit', 0));
      return taskkill;
    }
  }), /could not verify.*process tree/i);

  assert.equal(terminationCalls, 0);
  assert.equal(processes.get('project'), child);
});

test('reconciles an exited Windows child with no identity only after proving its tree is empty', async () => {
  const child = {
    pid: 617,
    exitCode: 0,
    signalCode: null,
    runlistIdentity: Promise.resolve(undefined)
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  assert.equal(await terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    isProcessAlive: () => false,
    readOwnedProcessTree: async () => [],
    spawnProcess: () => {
      terminationCalls += 1;
    }
  }), true);
  assert.equal(terminationCalls, 0);
  assert.equal(processes.has('project'), false);
});

test('reconciles an exited POSIX child with no identity only after proving its process group is gone', async () => {
  for (const platform of ['linux', 'darwin']) {
    const child = {
      pid: 624,
      exitCode: 7,
      signalCode: null,
      runlistIdentity: Promise.resolve(undefined)
    };
    const processes = new Map([['project', child]]);
    let terminationCalls = 0;

    assert.equal(await terminateTrackedProcess(processes, 'project', {
      platform,
      isProcessAlive: () => false,
      readProcessGroup: async () => [],
      kill: (pid, signal) => {
        if (signal === 0) {
          const error = new Error('gone');
          error.code = 'ESRCH';
          throw error;
        }
        terminationCalls += 1;
        return undefined;
      }
    }), true);
    assert.equal(terminationCalls, 0, `${platform} signaled after empty-group reconciliation`);
    assert.equal(processes.has('project'), false, `${platform} retained the exited handle`);
  }
});

test('does not let a pending POSIX identity probe delay empty-group reconciliation', async () => {
  const child = {
    pid: 625,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: new Promise(() => {})
  };
  const processes = new Map([['project', child]]);
  const result = await Promise.race([
    terminateTrackedProcess(processes, 'project', {
      exitedIdentityWaitMs: 5,
      platform: 'linux',
      isProcessAlive: () => false,
      readProcessGroup: async () => [],
      kill: (pid, signal) => {
        if (pid === -625 && signal === 0) {
          const error = new Error('gone');
          error.code = 'ESRCH';
          throw error;
        }
        throw new Error(`unexpected signal ${pid} ${signal}`);
      }
    }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100))
  ]);

  assert.equal(result, true);
  assert.equal(processes.has('project'), false);
});

test('keeps an exited POSIX child with no identity when its process group remains live', async () => {
  const child = {
    pid: 626,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: Promise.resolve(undefined)
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'linux',
    isProcessAlive: () => false,
    kill: (pid, signal) => {
      if (pid === -626 && signal === 0) {
        return true;
      }
      terminationCalls += 1;
      return undefined;
    }
  }), /could not verify.*process group/i);
  assert.equal(terminationCalls, 0);
  assert.equal(processes.get('project'), child);
});

test('does not let a pending Windows identity probe delay empty-tree reconciliation', async () => {
  const child = {
    pid: 623,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: new Promise(() => {})
  };
  const processes = new Map([['project', child]]);
  const result = await Promise.race([
    terminateTrackedProcess(processes, 'project', {
      exitedIdentityWaitMs: 5,
      platform: 'win32',
      readOwnedProcessTree: async () => []
    }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100))
  ]);

  assert.equal(result, true);
  assert.equal(processes.has('project'), false);
});

test('keeps an exited Windows child with no identity when descendants remain', async () => {
  const child = {
    pid: 621,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: new Promise(() => {})
  };
  const processes = new Map([['project', child]]);
  let terminationCalls = 0;

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    exitedIdentityWaitMs: 5,
    platform: 'win32',
    isProcessAlive: () => false,
    readOwnedProcessTree: async () => [{
      pid: 700,
      parentPid: 621,
      identity: '700:110'
    }],
    spawnProcess: () => {
      terminationCalls += 1;
    }
  }), /could not verify.*process tree/i);
  assert.equal(terminationCalls, 0);
  assert.equal(processes.get('project'), child);
});

test('keeps an exited Windows child with no identity when tree inspection fails', async () => {
  const child = {
    pid: 622,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: Promise.resolve(undefined)
  };
  const processes = new Map([['project', child]]);

  await assert.rejects(terminateTrackedProcess(processes, 'project', {
    platform: 'win32',
    isProcessAlive: () => false,
    readOwnedProcessTree: async () => {
      throw new Error('process query unavailable');
    }
  }), /process query unavailable/);
  assert.equal(processes.get('project'), child);
});

test('fails closed for rejected, empty, and whitespace identities when a Windows tree remains', async () => {
  const identityValues = [
    Promise.reject(new Error('identity probe failed')),
    Promise.resolve(''),
    Promise.resolve('   ')
  ];

  for (const [index, runlistIdentity] of identityValues.entries()) {
    const child = {
      pid: 618 + index,
      exitCode: 0,
      signalCode: null,
      runlistIdentity
    };
    const processes = new Map([['project', child]]);
    let terminationCalls = 0;

    await assert.rejects(terminateTrackedProcess(processes, 'project', {
      platform: 'win32',
      readOwnedProcessTree: async () => [{
        pid: child.pid,
        parentPid: 1,
        identity: `${child.pid}:replacement`
      }],
      readProcessIdentity: async () => '   ',
      spawnProcess: () => {
        terminationCalls += 1;
      }
    }), /could not verify.*process tree/i);
    assert.equal(terminationCalls, 0);
    assert.equal(processes.get('project'), child);
  }
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

test('rejects a reused host PID and withholds refresh or termination when identity is unsafe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-host-identity-'));
  let now = 1000;
  const alive = new Set([101, 202, 303]);
  const identities = new Map([
    [101, '101:original'],
    [202, '202:observer']
  ]);
  const readHostProcessIdentity = (pid) => identities.get(pid);
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: '101:original',
    now: () => now,
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity
  });
  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: '202:observer',
    now: () => now,
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  assert.equal(observer.snapshot().get('project-1').ownerAvailable, true);

  const ownershipPath = owner.ownershipPath('project-1');
  const originalRecord = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  identities.set(101, '101:replacement');
  now = 9000;

  assert.deepEqual(observer.requestStop('project-1'), { kind: 'uncertain' });
  assert.equal(observer.snapshot().has('project-1'), false);
  fs.writeFileSync(ownershipPath, JSON.stringify({
    ...originalRecord,
    hostIdentity: '101:replacement'
  }));
  assert.equal(owner.snapshot().has('project-1'), false);
  assert.equal(fs.existsSync(ownershipPath), false);
  assert.equal(owner.owns('project-1', 303), false);
  assert.equal(await owner.terminateOwnedProcess('project-1'), false);
  owner.touchOwned();
  assert.equal(fs.existsSync(ownershipPath), false);
});

test('treats missing or unavailable host identity as uncertain while preserving safe recovery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-host-identity-missing-'));
  const alive = new Set([101, 202, 303]);
  let hostIdentity = '101:original';
  const readHostProcessIdentity = () => hostIdentity;
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: '101:original',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity
  });
  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: '202:observer',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  const ownershipPath = owner.ownershipPath('project-1');
  const record = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  delete record.hostIdentity;
  fs.writeFileSync(ownershipPath, JSON.stringify(record));

  const missing = observer.snapshot().get('project-1');
  assert.equal(missing.ownerAvailable, false);
  assert.equal(missing.processActive, true);
  assert.deepEqual(observer.requestStop('project-1'), { kind: 'uncertain' });
  assert.equal(observer.reserve('project-1').kind, 'uncertain');

  record.hostIdentity = '101:original';
  fs.writeFileSync(ownershipPath, JSON.stringify(record));
  hostIdentity = undefined;
  const unavailable = observer.snapshot().get('project-1');
  assert.equal(unavailable.ownerAvailable, false);
  assert.deepEqual(observer.requestStop('project-1'), { kind: 'uncertain' });
  record.hostIdentity = '101:replacement';
  fs.writeFileSync(ownershipPath, JSON.stringify(record));
  assert.equal(await owner.terminateOwnedProcess('project-1'), false);
  alive.delete(101);
  alive.delete(303);
  hostIdentity = '101:replacement';
  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(observer.reserve('project-1'), undefined);
});

test('does not consume a custom Stop request after the owner identity changes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stop-request-identity-'));
  const alive = new Set([101, 202, 303]);
  let currentOwnerIdentity = '101:original';
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: '101:original',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity: (pid) => pid === 101 ? currentOwnerIdentity : '202:observer'
  });
  const requester = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: '202:observer',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity: (pid) => pid === 101 ? currentOwnerIdentity : '202:observer'
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  assert.deepEqual(requester.requestStop('project-1'), { kind: 'requested' });
  currentOwnerIdentity = '101:replacement';
  const ownershipPath = owner.ownershipPath('project-1');
  const replacedRecord = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  replacedRecord.hostIdentity = currentOwnerIdentity;
  fs.writeFileSync(ownershipPath, JSON.stringify(replacedRecord));

  assert.deepEqual(owner.consumeStopRequests(), []);
  const [failure] = owner.consumeStopRequestFailures();
  assert.equal(failure.projectId, 'project-1');
  assert.match(failure.message, /identity could not be verified/i);
  assert.equal(fs.existsSync(owner.stopRequestPath('project-1')), true);

  currentOwnerIdentity = '101:original';
  replacedRecord.hostIdentity = currentOwnerIdentity;
  fs.writeFileSync(ownershipPath, JSON.stringify(replacedRecord));
  assert.deepEqual(owner.consumeStopRequests(), ['project-1']);
});

test('rejects malformed child identity on the ownership termination path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-child-identity-invalid-'));
  const signals = [];
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => pid === 101 || pid === 303
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  assert.equal(owner.setProcess('project-1', 303, { childIdentity: ' 303:bad ' }), true);
  await assert.rejects(
    owner.terminateOwnedProcess('project-1', {
      kill: (pid, signal) => signals.push([pid, signal])
    }),
    /verify the launched process identity/i
  );
  assert.deepEqual(signals, []);
});

test('does not create ownership when host identity capture throws', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-host-identity-throw-'));
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    readHostProcessIdentity: () => { throw new Error('reader unavailable'); }
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.hostIdentity, undefined);
  assert.deepEqual(owner.reserve('project-1'), { kind: 'uncertain' });
  assert.equal(fs.existsSync(owner.ownershipPath('project-1')), false);
});

test('holds deletion ownership when this window already owns a stopped project', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-delete-hold-'));
  const alive = new Set([101]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    isProcessAlive: (pid) => alive.has(pid)
  });
  const otherWindow = new ProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve('project-1'), undefined);
  const token = owner.snapshot().get('project-1').token;
  // Simulate a failed Start / incomplete Stop that left ownership heartbeating
  // with no live child — the Delete path must still take the deletion lock.
  assert.equal(owner.reserve('project-1').kind, 'owned');
  assert.equal(owner.holdForDeletion('project-1', { expectedToken: token }), undefined);
  assert.equal(owner.isCurrentOwner('project-1'), true);
  assert.equal(otherWindow.holdForDeletion('project-1', { expectedToken: token }).kind, 'owned');
  assert.equal(owner.release('project-1'), true);
  assert.equal(fs.existsSync(owner.ownershipPath('project-1')), false);
});

test('refuses deletion hold when this window replaced ownership with a newer Start', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-delete-hold-race-'));
  const alive = new Set([101, 303, 304]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve('project-1'), undefined);
  const originalToken = owner.snapshot().get('project-1').token;
  assert.equal(owner.release('project-1'), true);
  assert.equal(owner.reserve('project-1'), undefined);
  owner.setProcess('project-1', 304, { state: 'running' });
  const replaced = owner.holdForDeletion('project-1', { expectedToken: originalToken });
  assert.equal(replaced.kind, 'owned');
  assert.notEqual(replaced.ownership.token, originalToken);
  assert.equal(owner.owns('project-1', 304), true);
});

test('does not release ownership after the local host identity changes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-release-identity-'));
  const alive = new Set([101]);
  let identity = '101:original';
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: '101:original',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity: () => identity
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  const ownershipPath = owner.ownershipPath('project-1');
  const replacedRecord = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  replacedRecord.hostIdentity = '101:replacement';
  fs.writeFileSync(ownershipPath, JSON.stringify(replacedRecord));
  assert.equal(owner.release('project-1'), false);
  assert.equal(fs.existsSync(owner.ownershipPath('project-1')), true);
  identity = '101:original';
  replacedRecord.hostIdentity = identity;
  fs.writeFileSync(ownershipPath, JSON.stringify(replacedRecord));
  assert.equal(owner.release('project-1'), true);
});

test('caches foreign host identity decisions but always refreshes before ownership actions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-host-identity-cache-'));
  const alive = new Set([101, 202]);
  let reads = 0;
  const readHostProcessIdentity = (pid) => {
    reads += 1;
    return pid === 101 ? '101:original' : '202:observer';
  };
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: '101:original',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity
  });
  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: '202:observer',
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity,
    hostIdentityCacheTtlMs: 1000
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  assert.equal(observer.snapshot().get('project-1').ownerAvailable, true);
  assert.equal(observer.snapshot().get('project-1').ownerAvailable, true);
  assert.equal(reads, 1, 'constructor captures are explicit; foreign snapshot reads are cached');
  assert.equal(observer.isCurrentOwner('project-1'), false);
  assert.equal(observer.isCurrentOwner('project-1', { fresh: true }), false);
});

test('reclaims only after a fresh tri-state identity decision proves it is safe', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-host-identity-tristate-'));
  let now = 1000;
  let hostIdentityAvailable = false;
  const alive = new Set([101, 202, 303]);
  const owner = new RealProcessOwnershipStore(directory, {
    pid: 101,
    platform: 'linux',
    hostIdentity: '101:original',
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: '202:observer',
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity: () => hostIdentityAvailable ? '101:original' : undefined,
    hostIdentityCacheTtlMs: 1000
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  now = 7001;
  assert.equal(observer.snapshot().has('project-1'), true);
  hostIdentityAvailable = true;
  assert.equal(observer.snapshot().has('project-1'), true);
  assert.equal(observer.reserve('project-1').kind, 'uncertain');

  hostIdentityAvailable = false;
  assert.equal(observer.snapshot().has('project-1'), true);
  assert.equal(observer.reserve('project-1').kind, 'uncertain');

  const ownershipPath = owner.ownershipPath('project-1');
  const record = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  record.hostIdentity = '101:replacement';
  fs.writeFileSync(ownershipPath, JSON.stringify(record));
  hostIdentityAvailable = true;
  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(observer.reserve('project-1'), undefined);
  assert.equal(observer.release('project-1'), true);

  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  hostIdentityAvailable = true;
  now = 9000;
  assert.equal(observer.snapshot().get('project-1').ownerAvailable, true);
  alive.delete(101);
  alive.delete(303);
  now = 10000;
  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(observer.reserve('project-1'), undefined);
});

test('reclaims unreadable ownership only when host and child absence are definitive', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-host-identity-dead-'));
  const alive = new Set([202]);
  const uncertain = new Set();
  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'linux',
    hostIdentity: '202:observer',
    isProcessAlive: (pid) => {
      if (uncertain.has(pid)) {
        throw new Error('liveness unavailable');
      }
      return alive.has(pid);
    },
    readHostProcessIdentity: () => undefined
  });
  const writeOwnership = (projectId, details = {}) => {
    fs.writeFileSync(observer.ownershipPath(projectId), JSON.stringify({
      projectId,
      hostPid: 101,
      platform: 'linux',
      state: 'running',
      heartbeatAt: 1000,
      token: `${projectId}-token`,
      hostIdentity: '101:original',
      ...details
    }));
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  writeOwnership('native-dead');
  assert.equal(observer.snapshot().has('native-dead'), false);
  assert.equal(observer.reserve('native-dead'), undefined);
  assert.equal(observer.release('native-dead'), true);

  writeOwnership('legacy-dead', { hostIdentity: undefined });
  assert.equal(observer.snapshot().has('legacy-dead'), false);
  assert.equal(observer.reserve('legacy-dead'), undefined);
  assert.equal(observer.release('legacy-dead'), true);

  alive.add(101);
  writeOwnership('live-unreadable');
  assert.equal(observer.snapshot().has('live-unreadable'), true);
  assert.equal(observer.reserve('live-unreadable').kind, 'uncertain');
  writeOwnership('legacy-live', { hostIdentity: undefined });
  assert.equal(observer.snapshot().has('legacy-live'), true);
  assert.equal(observer.reserve('legacy-live').kind, 'uncertain');

  alive.delete(101);
  alive.add(303);
  writeOwnership('child-live', { hostIdentity: undefined, childPid: 303 });
  assert.equal(observer.snapshot().has('child-live'), true);
  assert.equal(observer.reserve('child-live').kind, 'uncertain');
  alive.delete(303);
  assert.equal(observer.snapshot().has('child-live'), false);

  uncertain.add(101);
  writeOwnership('host-uncertain', { hostIdentity: undefined });
  assert.equal(observer.snapshot().has('host-uncertain'), true);
  assert.equal(observer.reserve('host-uncertain').kind, 'uncertain');
});

test('captures native process identities with safe platform-specific arguments', () => {
  const calls = [];
  const linuxFields = Array(20).fill('0');
  linuxFields[18] = '987654';
  assert.equal(readProcessIdentitySync(303, 'linux', {
    readFileSync: (filePath, encoding) => {
      calls.push(['read', filePath, encoding]);
      return `303 (node) S ${linuxFields.join(' ')}`;
    }
  }), '303:linux:987654');
  for (const malformed of [
    '303 (node S 0 0 0',
    '303 (node) S 0',
    `303 (node) S ${Array(18).fill('0').join(' ')} nope`,
    `303 (node) S ${Array(18).fill('0').join(' ')} 0`,
    `303 (node) S ${Array(18).fill('0').join(' ')} -1`
  ]) {
    assert.equal(readProcessIdentitySync(303, 'linux', {
      readFileSync: () => malformed
    }), undefined);
  }
  assert.equal(readProcessIdentitySync(303, 'win32', {
    execFileSync: (command, args) => {
      calls.push(['exec', command, args]);
      return 'T123456789';
    }
  }), '303:123456789');
  assert.equal(readProcessIdentitySync(303, 'darwin', {
    execFileSync: (command, args) => {
      calls.push(['exec', command, args]);
      return 'Mon Jan  1 00:00:00 2024 501 303 303 /usr/local/bin/node server.js';
    }
  }), expectedDarwinIdentity(303, '2024-01-01T00:00:00', {
    uid: 501,
    processGroupId: 303,
    sessionId: 303,
    command: '/usr/local/bin/node server.js'
  }));
  assert.equal(readProcessIdentitySync(0, 'win32', {
    execFileSync: () => { throw new Error('must not execute'); }
  }), undefined);
  assert.deepEqual(calls, [
    ['read', '/proc/303/stat', 'utf8'],
    ['exec', 'powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "('T' + (Get-Process -Id 303 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString())"
    ]],
    ['exec', 'ps', [
      '-ww', '-p', '303', '-o', 'lstart=', '-o', 'uid=', '-o', 'pgid=',
      '-o', 'sess=', '-o', 'command='
    ]]
  ]);
});

test('strengthens macOS identities with canonical command and stable numeric attributes', async () => {
  const outputs = [
    { uid: 501, pgid: 303, sessionId: 303, command: '/Applications/Node/bin/node server.js --port 3000' },
    { uid: 501, pgid: 303, sessionId: 303, command: '/Applications/Node/bin/node server.js --port 3000' },
    { uid: 501, pgid: 303, sessionId: 303, command: '/Applications/Node/bin/node server.js --port 4000' },
    { uid: 502, pgid: 303, sessionId: 303, command: '/Applications/Node/bin/node server.js --port 3000' },
    { uid: 501, pgid: 404, sessionId: 303, command: '/Applications/Node/bin/node server.js --port 3000' },
    { uid: 501, pgid: 303, sessionId: 404, command: '/Applications/Node/bin/node server.js --port 3000' }
  ];
  const calls = [];
  const runFile = async (command, args, options) => {
    calls.push({ command, args, options });
    const output = outputs.shift();
    return `303 1 ${output.pgid} ${output.sessionId} ${output.uid} Mon Jan  1 00:00:00 2024 00:01.00 1024 ${output.command}`;
  };

  const original = await readProcessIdentity(303, 'darwin', { runFile });
  const matching = await readProcessIdentity(303, 'darwin', { runFile });
  const argumentsChanged = await readProcessIdentity(303, 'darwin', { runFile });
  const uidChanged = await readProcessIdentity(303, 'darwin', { runFile });
  const groupChanged = await readProcessIdentity(303, 'darwin', { runFile });
  const sessionChanged = await readProcessIdentity(303, 'darwin', { runFile });

  assert.equal(matching, original);
  assert.notEqual(argumentsChanged, original);
  assert.notEqual(uidChanged, original);
  assert.notEqual(groupChanged, original);
  assert.notEqual(sessionChanged, original);
  assert.match(original, /^303:darwin:v2:2024-01-01T00:00:00:[a-f0-9]{64}$/);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.command, 'ps');
    assert.deepEqual(call.args, [
      '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'sess=',
      '-o', 'uid=', '-o', 'lstart=', '-o', 'time=', '-o', 'rss=',
      '-o', 'command=', '-p', '303'
    ]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.LC_ALL, 'C');
    assert.equal(call.options.env.LANG, 'C');
    assert.equal(call.options.env.TZ, 'UTC');
  }
});

test('documents the irreducible ps-only collision when all stable visible fields are identical', async () => {
  const output = '303 1 303 303 501 Mon Jan  1 00:00:00 2024 00:01.00 1024 /usr/local/bin/node server.js';
  const capture = () => readProcessIdentity(303, 'darwin', {
    runFile: async () => output
  });

  const first = await capture();
  assert.match(first, /^303:darwin:v2:/);
  assert.equal(first, await capture());
});

test('canonicalizes opaque macOS session tokens in sync and async captures', async () => {
  const base = {
    uid: 501,
    processGroupId: 303,
    command: '/usr/local/bin/node server.js'
  };
  assert.equal(readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => 'Mon Jan  1 00:00:00 2024 501 303 0 /usr/local/bin/node server.js'
  }), expectedDarwinIdentity(303, '2024-01-01T00:00:00', {
    ...base,
    sessionId: '0'
  }));

  const upper = await readProcessIdentity(303, 'darwin', {
    runFile: async () => '303 1 303 2FD65F0 501 Mon Jan  1 00:00:00 2024 00:01.00 1024 /usr/local/bin/node server.js'
  });
  const lower = await readProcessIdentity(303, 'darwin', {
    runFile: async () => '303 1 303 2fd65f0 501 Mon Jan  1 00:00:00 2024 00:01.00 1024 /usr/local/bin/node server.js'
  });
  assert.equal(upper, expectedDarwinIdentity(303, '2024-01-01T00:00:00', {
    ...base,
    sessionId: '2fd65f0'
  }));
  assert.equal(lower, upper);
});

test('accepts uid zero in a stable versioned macOS sync identity', () => {
  const details = {
    uid: 0,
    processGroupId: 303,
    sessionId: '2fd65f0',
    command: '/usr/local/bin/node root.js'
  };
  const identity = readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => 'Mon Jan  1 00:00:00 2024 0 303 2FD65F0 /usr/local/bin/node root.js'
  });

  assert.equal(identity, expectedDarwinIdentity(303, '2024-01-01T00:00:00', details));
  assert.match(identity, /^303:darwin:v2:/);
  assert.equal(readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => 'Mon Jan  1 00:00:00 2024 -1 303 2fd65f0 /usr/local/bin/node root.js'
  }), undefined);
});

test('parses macOS identity whitespace and fails closed on malformed or unavailable output', async () => {
  const expected = expectedDarwinIdentity(303, '2024-01-01T00:00:00', {
    uid: 501,
    processGroupId: 303,
    sessionId: 303,
    command: '/Applications/Node Runtime/bin/node server.js'
  });
  assert.equal(readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => '  Mon   Jan   1   00:00:00   2024   501   303   303   /Applications/Node Runtime/bin/node server.js  \n'
  }), expected);

  for (const output of [
    '',
    'Lun Jan  1 00:00:00 2024 501 303 303 /usr/local/bin/node',
    'Mon Xxx  1 00:00:00 2024 501 303 303 /usr/local/bin/node',
    'Mon Jan 32 00:00:00 2024 501 303 303 /usr/local/bin/node',
    'Mon Jan  1 25:00:00 2024 501 303 303 /usr/local/bin/node',
    'Mon Jan  1 00:00:00 nope 501 303 303 /usr/local/bin/node',
    'Mon Jan  1 00:00:00 2024 501 nope 303 /usr/local/bin/node',
    'Mon Jan  1 00:00:00 2024 501 303 nope /usr/local/bin/node',
    'Mon Jan  1 00:00:00 2024 501 303 303',
    'Mon Jan  1 00:00:00 2024 501 303 303 /usr/local/bin/node\u0007bad',
    'Mon Jan  1 00:00:00 2024 501 303 303 /usr/local/bin/node --first\n--forged-argument-row',
    'Mon Jan  1 00:00:00 2024 501 303 303 /usr/local/bin/node\nTue Jan  2 00:00:00 2024 501 303 303 /usr/bin/node'
  ]) {
    assert.equal(readProcessIdentitySync(303, 'darwin', {
      execFileSync: () => output
    }), undefined);
  }
  assert.equal(readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => { throw new Error('unavailable'); }
  }), undefined);
  assert.equal(await readProcessIdentity(303, 'darwin', {
    runFile: async () => { throw new Error('unavailable'); }
  }), undefined);

  let executed = false;
  assert.equal(await readProcessIdentity(0, 'darwin', {
    runFile: () => { executed = true; }
  }), undefined);
  assert.equal(executed, false);
});

test('rejects a same-second macOS replacement and legacy coarse identity before signaling', async () => {
  const original = readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => 'Mon Jan  1 00:00:00 2024 501 303 303 /Applications/Node/bin/node original.js'
  });
  const replacement = readProcessIdentitySync(303, 'darwin', {
    execFileSync: () => 'Mon Jan  1 00:00:00 2024 501 303 303 /Applications/Node/bin/node replacement.js'
  });
  const signals = [];

  for (const expectedIdentity of [original, '303:Mon Jan  1 00:00:00 2024']) {
    await assert.rejects(terminateProcessTree(303, {
      platform: 'darwin',
      expectedIdentity,
      readProcessIdentity: async () => replacement,
      kill: (...args) => signals.push(args)
    }), /process identity/);
  }
  assert.deepEqual(signals, []);
});

test('keeps legacy macOS ownership uncertain while live and reclaims only after definitive absence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-process-darwin-legacy-'));
  const alive = new Set([101, 202, 303]);
  const currentHostIdentity = expectedDarwinIdentity(101, '2024-01-01T00:00:00', {
    uid: 501,
    processGroupId: 101,
    sessionId: 101,
    command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
  });
  const currentChildIdentity = expectedDarwinIdentity(303, '2024-01-01T00:00:01', {
    uid: 501,
    processGroupId: 303,
    sessionId: 303,
    command: '/usr/local/bin/node server.js'
  });
  const observer = new RealProcessOwnershipStore(directory, {
    pid: 202,
    platform: 'darwin',
    hostIdentity: expectedDarwinIdentity(202, '2024-01-01T00:00:02', {
      uid: 501,
      processGroupId: 202,
      sessionId: 202,
      command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
    }),
    isProcessAlive: (pid) => alive.has(pid),
    readHostProcessIdentity: () => currentHostIdentity,
    readProcessIdentity: async () => currentChildIdentity
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(observer.ownershipPath('legacy-darwin'), JSON.stringify({
    projectId: 'legacy-darwin',
    hostPid: 101,
    platform: 'darwin',
    state: 'running',
    heartbeatAt: 1000,
    token: 'legacy-token',
    hostIdentity: '101:Mon Jan  1 00:00:00 2024',
    childPid: 303,
    childIdentity: '303:1704067201000'
  }));

  assert.equal(observer.snapshot().get('legacy-darwin').ownerAvailable, false);
  assert.equal(observer.reserve('legacy-darwin').kind, 'uncertain');
  assert.equal(await observer.reconcileProcessIdentities(), 0);
  assert.equal(observer.snapshot().has('legacy-darwin'), true);

  alive.delete(101);
  assert.equal(observer.snapshot().has('legacy-darwin'), true);
  alive.delete(303);
  assert.equal(observer.snapshot().has('legacy-darwin'), false);
  assert.equal(observer.reserve('legacy-darwin'), undefined);
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
          token: 'new-owner-token',
          hostIdentity: 'test-host:202'
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

test('readPersistedSnapshot reads saved ownership without live process probes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-persisted-snapshot-'));
  let probeCount = 0;
  const owner = new ProcessOwnershipStore(directory, {
    pid: process.pid,
    now: () => 1_000,
    isProcessAlive: () => {
      probeCount += 1;
      return true;
    }
  });
  const reader = new ProcessOwnershipStore(directory, {
    pid: process.pid + 1,
    now: () => 1_000,
    isProcessAlive: () => {
      probeCount += 1;
      return true;
    }
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', process.pid);
  probeCount = 0;

  const snapshot = reader.readPersistedSnapshot('project-1');
  assert.equal(probeCount, 0);
  assert.equal(snapshot.get('project-1')?.state, 'running');
  assert.equal(snapshot.get('project-1')?.ownerHeartbeatFresh, true);
});
