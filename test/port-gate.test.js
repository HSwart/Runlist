const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  occupiedPortsBelongToProject,
  occupiedPortConflict,
  PortReservationStore: RealPortReservationStore,
  projectsUsingPort,
  releaseProjectPorts,
  reserveProjectPorts
} = require('../src/ports/port-gate');
const { currentProcessIdentity } = require('../src/lifecycle/process-identity');
const { readRootProcess } = require('../src/lifecycle/process-metrics');

test('uses the retrying atomic writer for lifecycle port reservations', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ports', 'port-gate.js'), 'utf8');

  assert.match(source, /writeFileAtomically[\s\S]*require\('\.\.\/projects\/project-store'\)/);
  assert.match(source, /function writeJsonAtomically[\s\S]*writeFileAtomically\(filePath, JSON\.stringify\(value\)\)/);
});

const projects = [
  { id: 'alpha', name: 'Alpha', services: [{ name: 'web', port: 3000 }] },
  { id: 'beta', name: 'Beta', services: [{ name: 'web', port: 3000 }] },
  { id: 'gamma', name: 'Gamma', services: [{ name: 'api', port: 4000 }] }
];

function expectedDarwinIdentity(pid, startedAt, details) {
  const canonical = [
    'runlist-darwin-process',
    'v2',
    String(pid),
    startedAt,
    String(details.uid),
    String(details.processGroupId),
    String(details.sessionId),
    details.command
  ].map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('');
  return `${pid}:darwin:v2:${startedAt}:${crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')}`;
}

function testHostIdentity(pid, platform = process.platform) {
  return platform === 'darwin'
    ? expectedDarwinIdentity(pid, '2026-08-16T10:00:00', {
      uid: 501,
      processGroupId: pid,
      sessionId: pid,
      command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
    })
    : `test-host:${pid}`;
}

function changedCurrentProcessIdentity() {
  const identity = currentProcessIdentity({ allowRuntimeFallback: true });
  const final = identity.at(-1);
  return `${identity.slice(0, -1)}${final === '0' ? '1' : '0'}`;
}

function PortReservationStore(directory, options = {}) {
  const pid = options.pid || process.pid;
  const platform = options.platform || 'linux';
  return new RealPortReservationStore(directory, {
    ...options,
    platform,
    hostIdentity: options.hostIdentity || testHostIdentity(pid, platform),
    readHostProcessIdentity: options.readHostProcessIdentity
      || ((hostPid, hostPlatform) => testHostIdentity(hostPid, hostPlatform))
  });
}

test('reports reservation conflicts and stale transaction-lock recovery without port values', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-diagnostics-'));
  const transactionPath = path.join(directory, '.reservation-transaction.lock');
  const events = [];
  const old = new Date(Date.now() - 10000);
  fs.writeFileSync(transactionPath, JSON.stringify({
    pid: 999999,
    processIdentity: '999999:dead',
    createdAt: old.getTime(),
    token: 'stale-transaction'
  }));
  fs.utimesSync(transactionPath, old, old);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => pid === 101 || pid === 202,
    onDiagnostic: (event, details) => events.push({ event, ...details })
  });
  assert.equal(first.reserve({ id: 'project-1', services: [{ port: 4317 }] }), undefined);

  const second = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => pid === 101 || pid === 202,
    onDiagnostic: (event, details) => events.push({ event, ...details })
  });
  assert.equal(second.reserve({ id: 'project-2', services: [{ port: 4317 }] }).projectId, 'project-1');

  assert.ok(events.some((event) => event.event === 'transaction.stale-recovered'
    && event.reasonCode === 'owner-absent'));
  assert.ok(events.some((event) => event.event === 'transaction.acquired'
    && event.reasonCode === 'after-contention'));
  assert.ok(events.some((event) => event.event === 'reservation.acquired'
    && event.projectId === 'project-1'));
  assert.ok(events.some((event) => event.event === 'reservation.blocked'
    && event.projectId === 'project-2'
    && event.reasonCode === 'reserved-by-project'));
  assert.equal(JSON.stringify(events).includes('4317'), false);
});

test('finds other saved projects that share a configured port', () => {
  assert.deepEqual(
    projectsUsingPort(projects, 3000, 'alpha').map((project) => project.id),
    ['beta']
  );
  assert.deepEqual(projectsUsingPort(projects, 4000, 'gamma'), []);
});

test('reserves every project port atomically and releases only its own reservations', () => {
  const reservations = new Map([[5000, 'other']]);
  const project = {
    id: 'alpha',
    services: [{ name: 'web', port: 3000 }, { name: 'api', port: 5000 }]
  };
  assert.deepEqual(reserveProjectPorts(reservations, project), {
    port: 5000,
    projectId: 'other'
  });
  assert.equal(reservations.has(3000), false);

  reservations.delete(5000);
  assert.equal(reserveProjectPorts(reservations, project), undefined);
  assert.equal(reservations.get(3000), 'alpha');
  assert.equal(reservations.get(5000), 'alpha');
  releaseProjectPorts(reservations, 'alpha');
  assert.equal(reservations.size, 0);
});

test('blocks a concurrent reservation for the same port', () => {
  const reservations = new Map();
  assert.equal(reserveProjectPorts(reservations, projects[0]), undefined);
  assert.deepEqual(reserveProjectPorts(reservations, projects[1]), {
    port: 3000,
    projectId: 'alpha'
  });
});

test('blocks starting the same project twice while its ports remain reserved', () => {
  const reservations = new Map();
  assert.equal(reserveProjectPorts(reservations, projects[0]), undefined);
  assert.deepEqual(reserveProjectPorts(reservations, projects[0]), {
    port: 3000,
    projectId: 'alpha'
  });
});

test('rolls back every earlier port when a later reservation throws', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-reserve-rollback-'));
  const reservations = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  const project = {
    id: 'partial',
    services: [{ name: 'web', port: 4317 }, { name: 'api', port: 4318 }]
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const acquire = reservations.acquire.bind(reservations);
  reservations.acquire = (port, projectId) => {
    if (port === 4318) {
      throw Object.assign(new Error('simulated port I/O failure'), { code: 'EIO' });
    }
    return acquire(port, projectId);
  };

  assert.throws(() => reservations.reserve(project), /simulated port I\/O failure/);
  assert.equal(fs.existsSync(path.join(directory, 'port-4317.lock')), false);
  assert.equal(reservations.locks.has(4317), false);

  reservations.acquire = acquire;
  assert.equal(reservations.reserve({
    id: 'replacement',
    services: [{ name: 'web', port: 4317 }]
  }), undefined);
  assert.equal(reservations.snapshot().get('replacement'), 'starting');
});

test('attempts every exact port cleanup and preserves the reservation error', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-cleanup-failure-'));
  const reservations = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  const project = {
    id: 'cleanup-failure',
    services: [
      { name: 'web', port: 4317 },
      { name: 'api', port: 4318 },
      { name: 'worker', port: 4319 }
    ]
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const acquire = reservations.acquire.bind(reservations);
  const releasePort = reservations.releasePort.bind(reservations);
  const released = [];
  reservations.acquire = (port, projectId) => {
    if (port === 4319) {
      throw Object.assign(new Error('original port I/O failure'), { code: 'EIO' });
    }
    return acquire(port, projectId);
  };
  reservations.releasePort = (port) => {
    released.push(port);
    releasePort(port);
    if (port === 4317) {
      throw new Error('first cleanup failure');
    }
  };

  let thrown;
  try {
    reservations.reserve(project);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'EIO');
  assert.deepEqual(released, [4317, 4318]);
  assert.deepEqual(thrown?.cleanupErrors?.map((error) => error.message), ['first cleanup failure']);
  assert.equal(fs.existsSync(path.join(directory, 'port-4317.lock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'port-4318.lock')), false);
});

test('cleans an exact lock when acquire throws after registering it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-acquire-side-effect-'));
  const reservations = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const set = reservations.locks.set.bind(reservations.locks);
  reservations.locks.set = (port, lock) => {
    set(port, lock);
    if (port === 4320) {
      throw Object.assign(new Error('registered lock failure'), { code: 'EIO' });
    }
  };

  let thrown;
  try {
    reservations.reserve({ id: 'registered-side-effect', services: [{ name: 'web', port: 4320 }] });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'EIO');
  assert.equal(fs.existsSync(path.join(directory, 'port-4320.lock')), false);
  assert.equal(reservations.locks.has(4320), false);
});

test('coordinates reservations across independent extension hosts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-gate-'));
  let now = 1000;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstHost = new PortReservationStore(directory, {
    pid: 101,
    now: () => now,
    isProcessAlive: () => true
  });
  const secondHost = new PortReservationStore(directory, {
    pid: 202,
    now: () => now,
    isProcessAlive: () => true
  });

  assert.equal(firstHost.reserve(projects[0]), undefined);
  assert.equal(secondHost.snapshot().get('alpha'), 'starting');
  assert.equal(firstHost.setState('alpha', 'running'), true);
  assert.equal(secondHost.snapshot().get('alpha'), 'running');
  assert.deepEqual(secondHost.reserve(projects[1]), { port: 3000, projectId: 'alpha' });
  const generation = secondHost.captureShared('alpha');
  const beforeForeignUpdate = JSON.parse(fs.readFileSync(
    path.join(directory, 'port-3000.lock'),
    'utf8'
  ));
  now = 12000;
  assert.equal(secondHost.setState('alpha', 'stopping'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(directory, 'port-3000.lock'),
    'utf8'
  )), beforeForeignUpdate);
  assert.equal(secondHost.setStateShared('alpha', 'stopping', generation), true);
  assert.equal(firstHost.snapshot().get('alpha'), 'stopping');
  secondHost.releaseShared('alpha', generation);
  assert.equal(firstHost.snapshot().has('alpha'), false);
  assert.equal(secondHost.reserve(projects[1]), undefined);
  secondHost.dispose();
});

test('does not let a same-PID replacement refresh a stale local port lock', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-state-reuse-'));
  let now = 1000;
  const replacement = new PortReservationStore(directory, {
    pid: 101,
    now: () => now,
    hostIdentity: '101:replacement-host',
    isProcessAlive: () => true
  });
  const owner = new PortReservationStore(directory, {
    pid: 101,
    now: () => now,
    hostIdentity: '101:original-host',
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve(projects[0]);
  const original = JSON.parse(fs.readFileSync(path.join(directory, 'port-3000.lock'), 'utf8'));
  now = 12000;
  assert.equal(replacement.setState('alpha', 'running'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(directory, 'port-3000.lock'),
    'utf8'
  )), original);
});

test('keeps detached port reservations after the launching host exits', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-port-'));
  const alive = new Set([101, 303]);
  const owner = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const project = { id: 'detached', services: [{ name: 'web', port: 4312 }] };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve(project), undefined);
  owner.setProcess(project.id, 303);
  owner.markDetached(project.id);
  alive.delete(101);
  alive.delete(303);

  assert.equal(observer.snapshot().get(project.id), 'detached');
  assert.deepEqual(observer.reserve({
    id: 'other',
    services: [{ name: 'web', port: 4312 }]
  }), { port: 4312, projectId: project.id });

  observer.releaseShared(project.id, observer.captureShared(project.id));
  assert.equal(observer.snapshot().has(project.id), false);
});

test('does not let stale detached cleanup remove a replacement reservation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-port-generation-'));
  const alive = new Set([101, 202]);
  const owner = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const detached = { id: 'detached', services: [{ name: 'web', port: 4313 }] };
  const replacement = { id: 'replacement', services: [{ name: 'web', port: 4313 }] };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve(detached), undefined);
  owner.markDetached(detached.id);
  const staleGeneration = owner.captureShared(detached.id);
  assert.equal(observer.releaseShared(detached.id, staleGeneration), true);
  assert.equal(observer.reserve(replacement), undefined);

  assert.equal(owner.releaseShared(detached.id, staleGeneration), false);
  assert.equal(observer.snapshot().get(replacement.id), 'starting');
});

test('keeps a replacement reservation when force-close cleanup runs after an async gap', async (t) => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const forceCloseStart = extension.indexOf('async forceCloseProjectPorts(');
  const recoveryStart = extension.indexOf('const result = await recoverProjectPorts', forceCloseStart);
  const finishStart = extension.indexOf('finishStopping(id, succeeded, portGeneration)');
  assert.ok(forceCloseStart >= 0);
  assert.match(extension.slice(forceCloseStart, recoveryStart), /const portGeneration = this\.portReservations\.captureShared\(id\);/);
  assert.match(extension.slice(forceCloseStart), /this\.finishStopping\(id, true, portGeneration\)/);
  assert.doesNotMatch(extension.slice(finishStart, finishStart + 800), /: this\.portReservations\.captureShared\(id\)/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-force-close-generation-'));
  const alive = new Set([101, 202]);
  const owner = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const detached = { id: 'detached', services: [{ name: 'web', port: 4315 }] };
  const replacement = { id: 'replacement', services: [{ name: 'web', port: 4315 }] };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve(detached), undefined);
  owner.markDetached(detached.id);
  const capturedBeforeAsyncForceClose = owner.captureShared(detached.id);
  await Promise.resolve();
  assert.equal(observer.releaseShared(detached.id, capturedBeforeAsyncForceClose), true);
  assert.equal(observer.reserve(replacement), undefined);

  assert.equal(owner.releaseShared(detached.id, capturedBeforeAsyncForceClose), false);
  assert.equal(observer.snapshot().get(replacement.id), 'starting');
});

test('serializes complete overlapping multi-port reservations across hosts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-transaction-'));
  const alive = new Set([101, 202]);
  const first = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const second = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(first.reserve({
    id: 'first',
    services: [{ port: 4310 }, { port: 4311 }]
  }), undefined);
  assert.deepEqual(second.reserve({
    id: 'second',
    services: [{ port: 4311 }, { port: 4312 }]
  }), { port: 4311, projectId: 'first' });
  assert.deepEqual(second.conflicts({
    id: 'second',
    services: [{ port: 4311 }, { port: 4312 }]
  }), [{ port: 4311, projectId: 'first' }]);
  assert.equal(fs.existsSync(path.join(directory, 'port-4312.lock')), false);
});

test('recovers transaction and update locks after their host PID is reused', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-reused-lock-owner-'));
  const transactionPath = path.join(directory, '.reservation-transaction.lock');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(transactionPath, JSON.stringify({
    pid: process.pid,
    processIdentity: changedCurrentProcessIdentity(),
    token: 'stale-transaction'
  }));
  fs.writeFileSync(`${transactionPath}.update`, JSON.stringify({
    pid: process.pid,
    processIdentity: changedCurrentProcessIdentity()
  }));

  const reservations = new PortReservationStore(directory, {
    invalidRecordGraceMs: 60_000
  });

  assert.equal(reservations.reserve(projects[0]), undefined);
  assert.equal(fs.existsSync(transactionPath), false);
  assert.equal(fs.existsSync(`${transactionPath}.update`), false);
});

test('retries a reservation after its confirmed owner has exited', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-dead-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reservations = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => pid === 202
  });
  fs.writeFileSync(path.join(directory, 'port-4310.lock'), JSON.stringify({
    pid: 101,
    projectId: 'stopped-project',
    state: 'running',
    heartbeatAt: Date.now(),
    token: 'stale-token'
  }));

  assert.equal(reservations.reserve({
    id: 'next-project',
    services: [{ port: 4310 }]
  }), undefined);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(directory, 'port-4310.lock'),
    'utf8'
  )).projectId, 'next-project');
});

test('persists the stable extension-host identity in each port lock', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-host-identity-'));
  const reservations = new PortReservationStore(directory, {
    pid: 101,
    hostIdentity: '101:original-host',
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(reservations.reserve(projects[0]), undefined);
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'port-3000.lock'), 'utf8'));
  assert.equal(lock.pid, 101);
  assert.equal(lock.hostIdentity, '101:original-host');
  assert.equal(lock.platform, 'linux');
});

test('reclaims a fresh port lock when its host PID was reused', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-host-reuse-'));
  const owner = new PortReservationStore(directory, {
    pid: 101,
    hostIdentity: '101:original-host',
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  owner.reserve(projects[0]);

  const observer = new PortReservationStore(directory, {
    pid: 202,
    hostIdentity: '202:observer-host',
    isProcessAlive: () => true,
    readHostProcessIdentity: (pid) => pid === 101
      ? '101:replacement-host'
      : '202:observer-host'
  });

  assert.equal(observer.snapshot().has('alpha'), false);
  assert.equal(observer.reserve(projects[1]), undefined);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(directory, 'port-3000.lock'),
    'utf8'
  )).projectId, 'beta');
});

test('keeps live port locks fail-closed when host identity is unavailable or legacy', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-host-uncertain-'));
  let now = 1000;
  let oldHostAlive = true;
  const owner = new PortReservationStore(directory, {
    pid: 101,
    now: () => now,
    hostIdentity: '101:original-host',
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  owner.reserve(projects[0]);
  now = 20000;

  const unreadableObserver = new PortReservationStore(directory, {
    pid: 202,
    now: () => now,
    hostIdentity: '202:observer-host',
    isProcessAlive: (pid) => pid === 202 || (pid === 101 && oldHostAlive),
    readHostProcessIdentity: () => undefined
  });
  assert.equal(unreadableObserver.snapshot().get('alpha'), 'starting');
  assert.deepEqual(unreadableObserver.reserve(projects[1]), {
    port: 3000,
    projectId: 'alpha'
  });

  owner.release('alpha');
  fs.writeFileSync(path.join(directory, 'port-3000.lock'), JSON.stringify({
    pid: 101,
    projectId: 'legacy',
    state: 'running',
    heartbeatAt: now,
    token: 'legacy-token'
  }));
  assert.equal(unreadableObserver.snapshot().get('legacy'), 'running');
  oldHostAlive = false;
  assert.equal(unreadableObserver.snapshot().has('legacy'), false);
  assert.equal(unreadableObserver.reserve(projects[1]), undefined);
});

test('does not create a PID-only port lock when host identity capture throws', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-host-capture-'));
  const reservations = new RealPortReservationStore(directory, {
    pid: 101,
    isProcessAlive: () => true,
    readHostProcessIdentity: () => {
      throw new Error('identity reader failed');
    }
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () => reservations.reserve(projects[0]),
    /could not verify the port reservation host identity/i
  );
  assert.equal(fs.existsSync(path.join(directory, 'port-3000.lock')), false);
});

test('reports every live Runlist reservation that blocks a project', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-conflicts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstHost = new PortReservationStore(directory, { pid: 101, isProcessAlive: () => true });
  const secondHost = new PortReservationStore(directory, { pid: 202, isProcessAlive: () => true });
  const observer = new PortReservationStore(directory, { pid: 303, isProcessAlive: () => true });
  firstHost.reserve(projects[0]);
  secondHost.reserve(projects[2]);

  assert.deepEqual(observer.conflicts({
    id: 'requested',
    services: [{ name: 'web', port: 3000 }, { name: 'api', port: 4000 }]
  }), [
    { port: 3000, projectId: 'alpha' },
    { port: 4000, projectId: 'gamma' }
  ]);
});

test('requires every occupied target port to belong to the same Runlist project', () => {
  const reservations = [
    { port: 3000, projectId: 'alpha' },
    { port: 4000, projectId: 'gamma' }
  ];

  assert.equal(occupiedPortsBelongToProject([3000], reservations, 'alpha'), true);
  assert.equal(occupiedPortsBelongToProject([3000, 4000], reservations, 'alpha'), false);
  assert.equal(occupiedPortsBelongToProject([3000, 5000], reservations, 'alpha'), false);
  assert.equal(occupiedPortsBelongToProject(undefined, reservations, 'alpha'), false);
});

test('removes abandoned locks without deleting another host lock', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stale-port-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'port-3000.lock'),
    JSON.stringify({ pid: 101, projectId: 'old', token: 'old-token' })
  );

  const currentHost = new PortReservationStore(directory, {
    pid: 202,
    isProcessAlive: (pid) => pid !== 101
  });
  assert.equal(currentHost.reserve(projects[0]), undefined);

  const otherHost = new PortReservationStore(directory, { pid: 303, isProcessAlive: () => true });
  currentHost.release('not-the-owner');
  assert.deepEqual(otherHost.reserve(projects[1]), { port: 3000, projectId: 'alpha' });
  currentHost.dispose();
});

test('keeps a reservation after the extension host crashes while its child is alive', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-child-port-gate-'));
  const alive = new Set([101, 303]);
  const isProcessAlive = (pid) => alive.has(pid);
  const owner = new PortReservationStore(directory, { pid: 101, isProcessAlive });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(owner.reserve(projects[0]), undefined);
  owner.setProcess('alpha', 303, '303:original');
  alive.delete(101);

  const observer = new PortReservationStore(directory, { pid: 202, isProcessAlive });
  assert.equal(observer.snapshot().get('alpha'), 'starting');
  assert.deepEqual(observer.conflicts(projects[1]), [{ port: 3000, projectId: 'alpha' }]);
  assert.deepEqual(observer.reserve(projects[1]), { port: 3000, projectId: 'alpha' });

  alive.delete(303);
  assert.equal(observer.snapshot().has('alpha'), false);
  assert.equal(observer.reserve(projects[1]), undefined);
});

test('does not let a delayed child identity overwrite a newer port reservation generation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-generation-'));
  const reservations = new PortReservationStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(reservations.reserve(projects[0]), undefined);
  const firstGeneration = reservations.capture('alpha');
  assert.equal(reservations.setProcess('alpha', 303, undefined, firstGeneration), 1);
  reservations.release('alpha');

  assert.equal(reservations.reserve(projects[0]), undefined);
  const secondGeneration = reservations.capture('alpha');
  assert.equal(reservations.setProcess('alpha', 404, undefined, secondGeneration), 1);
  assert.equal(reservations.setProcess('alpha', 303, '303:old', firstGeneration), 0);

  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'port-3000.lock'), 'utf8'));
  assert.equal(lock.childPid, 404);
  assert.equal(lock.childIdentity, undefined);
});

test('removes an unavailable host reservation when its child PID identity was reused', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-child-identity-'));
  let now = 1000;
  const owner = new PortReservationStore(directory, {
    pid: 101,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => [101, 303].includes(pid),
    readProcessIdentity: async () => '303:original'
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve(projects[0]);
  owner.setProcess('alpha', 303, '303:original', owner.capture('alpha'));
  now = 7001;
  const observer = new PortReservationStore(directory, {
    pid: 202,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => pid === 303,
    readProcessIdentity: async () => '303:replacement'
  });

  assert.equal(await observer.reconcileProcessIdentities(), 1);
  assert.equal(observer.snapshot().has('alpha'), false);
});

test('keeps an abandoned macOS port lock for the matching strong identity and rejects reuse', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-darwin-identity-'));
  let now = 1000;
  let command = '/Applications/Original/bin/node';
  const identityFor = (value) => expectedDarwinIdentity(303, '2026-08-16T12:00:00', {
    uid: 501,
    processGroupId: 303,
    sessionId: 303,
    command: value
  });
  const owner = new PortReservationStore(directory, {
    pid: 101,
    platform: 'darwin',
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => [101, 303].includes(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve(projects[0]);
  owner.setProcess('alpha', 303, identityFor(command), owner.capture('alpha'));
  now = 7001;
  const observer = new PortReservationStore(directory, {
    pid: 202,
    platform: 'darwin',
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => pid === 303,
    readProcessIdentity: async (pid, platform) => (await readRootProcess(pid, platform, {
      runFile: async () => ` 303 1 303 303 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 ${command}`
    }))?.identity
  });

  assert.equal(await observer.reconcileProcessIdentities(), 0);
  assert.equal(observer.snapshot().has('alpha'), true);
  command = '/Applications/Replacement/bin/node';
  assert.equal(await observer.reconcileProcessIdentities(), 1);
  assert.equal(observer.snapshot().has('alpha'), false);
});

test('keeps a live legacy macOS port lock uncertain and reclaims it only after absence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-darwin-legacy-'));
  let now = 1000;
  let childAlive = true;
  const owner = new PortReservationStore(directory, {
    pid: 101,
    platform: 'darwin',
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => pid === 101 || (pid === 303 && childAlive)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve(projects[0]);
  owner.setProcess('alpha', 303, '303:1704067200000', owner.capture('alpha'));
  now = 7001;
  const currentIdentity = expectedDarwinIdentity(303, '2026-08-16T12:00:00', {
    uid: 501,
    processGroupId: 303,
    sessionId: 303,
    command: '/usr/local/bin/node server.js'
  });
  const observer = new PortReservationStore(directory, {
    pid: 202,
    platform: 'darwin',
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive: (pid) => pid === 303 && childAlive,
    readProcessIdentity: async () => currentIdentity
  });

  assert.equal(await observer.reconcileProcessIdentities(), 0);
  assert.equal(observer.snapshot().has('alpha'), true);
  childAlive = false;
  assert.equal(observer.snapshot().has('alpha'), false);
});

test('expires a reservation after a reused host PID stops heartbeating', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-heartbeat-'));
  let now = 1000;
  const isProcessAlive = (pid) => pid === 101;
  const owner = new PortReservationStore(directory, {
    pid: 101,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive
  });
  const observer = new PortReservationStore(directory, {
    pid: 202,
    now: () => now,
    ownerHeartbeatTimeoutMs: 5000,
    isProcessAlive
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve(projects[0]);
  assert.equal(observer.snapshot().get('alpha'), 'starting');

  now = 7001;
  assert.equal(observer.snapshot().has('alpha'), false);
  assert.equal(observer.reserve(projects[1]), undefined);
});

test('recovers old corrupt coordination records without deleting fresh partial writes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-corrupt-port-gate-'));
  const lockPath = path.join(directory, 'port-3000.lock');
  fs.writeFileSync(lockPath, '{');
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(lockPath, old, old);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const reservations = new PortReservationStore(directory, {
    pid: 202,
    invalidRecordGraceMs: 1000,
    isProcessAlive: () => false
  });
  assert.equal(reservations.reserve(projects[0]), undefined);

  reservations.dispose();
  fs.writeFileSync(lockPath, '{');
  const observer = new PortReservationStore(directory, {
    pid: 303,
    invalidRecordGraceMs: 1000,
    isProcessAlive: () => false
  });
  assert.deepEqual(observer.reserve(projects[0]), { port: 3000, projectId: undefined });
});

test('prioritizes managed ownership over ambiguous and unknown listeners', () => {
  const managed = occupiedPortConflict({
    project: projects[1],
    projects,
    managedProjectIds: new Set(['alpha']),
    openPorts: [3000]
  });
  assert.equal(managed.kind, 'managed');
  assert.equal(managed.owner.id, 'alpha');

  const ambiguous = occupiedPortConflict({
    project: projects[1],
    projects,
    managedProjectIds: new Set(),
    openPorts: [3000]
  });
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.deepEqual(ambiguous.sharedWith.map((project) => project.id), ['alpha']);

  const occupied = occupiedPortConflict({
    project: projects[2],
    projects,
    managedProjectIds: new Set(),
    openPorts: [4000]
  });
  assert.equal(occupied.kind, 'occupied');
});

test('does not report a managed project as conflicting with itself', () => {
  assert.equal(occupiedPortConflict({
    project: projects[0],
    projects,
    managedProjectIds: new Set(['alpha']),
    openPorts: [3000]
  }), undefined);
});

test('blocks a multi-service project when any one service port is ambiguous', () => {
  const multiServiceProject = {
    id: 'multi',
    name: 'Multi',
    services: [{ name: 'web', port: 7000 }, { name: 'api', port: 3000 }]
  };
  const conflict = occupiedPortConflict({
    project: multiServiceProject,
    projects: [...projects, multiServiceProject],
    managedProjectIds: new Set(),
    openPorts: [3000]
  });
  assert.equal(conflict.kind, 'ambiguous');
  assert.equal(conflict.port, 3000);
});
