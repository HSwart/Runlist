const assert = require('node:assert/strict');
const Module = require('node:module');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ProcessOwnershipStore: RealProcessOwnershipStore,
  restartProjectSafely
} = require('../src/lifecycle/project-process');
const { ProjectLifecycleCoordinator } = require('../src/lifecycle/project-lifecycle');
const { readShippedHostSource } = require('./helpers/extension-source');

function ProcessOwnershipStore(directory, options = {}) {
  const pid = options.pid || process.pid;
  return new RealProcessOwnershipStore(directory, {
    ...options,
    platform: options.platform || 'linux',
    hostIdentity: options.hostIdentity || `test-host:${pid}`,
    readHostProcessIdentity: options.readHostProcessIdentity
      || ((hostPid) => `test-host:${hostPid}`)
  });
}

function loadRunlistProvider(spawnImplementation, messages, moduleOverrides = {}) {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    window: {
      showErrorMessage(message) {
        messages.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage: () => Promise.resolve(undefined)
    },
    env: { remoteName: undefined }
  };
  const originalLoad = Module._load;
  const originalSpawn = childProcess.spawn;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    const loaded = originalLoad.call(this, request, parent, isMain);
    const override = moduleOverrides[request]
      || moduleOverrides[request.replace(/^\.\.\//, './src/')];
    return override ? { ...loaded, ...override } : loaded;
  };
  childProcess.spawn = spawnImplementation;
  try {
    providerModule._compile(source, providerPath);
    return providerModule.exports.RunlistViewProvider;
  } finally {
    childProcess.spawn = originalSpawn;
    Module._load = originalLoad;
  }
}

function createIntervalHarness() {
  const timers = new Set();
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay, active: true };
    timers.add(timer);
    return timer;
  };
  global.clearInterval = (timer) => {
    if (timer) {
      timer.active = false;
    }
  };
  return {
    tick(delay, index) {
      const matching = [...timers].filter((timer) => timer.active && timer.delay === delay);
      const selected = index === undefined ? matching : [matching[index]];
      for (const timer of selected) {
        timer?.callback();
      }
    },
    restore() {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  };
}

function createStatusMonitorProvider(Provider, owner, portReservations, services = [{ name: 'Web', port: 4320 }]) {
  const provider = Object.create(Provider.prototype);
  const project = {
    id: 'project-1',
    name: 'Project',
    folder: process.cwd(),
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services
  };
  Object.defineProperty(provider, 'projects', { value: [project] });
  provider.lifecycleCapability = { supported: true };
  provider.processes = new Map();
  provider.processOwnership = owner;
  provider.portReservations = portReservations;
  provider.managedProjectIds = new Set(['project-1']);
  provider.detachedProjectIds = new Set();
  provider.startAttempts = new Map();
  provider.remoteStopRequests = new Map();
  provider.stoppingProjectIds = new Set();
  provider.statusRefreshInFlight = false;
  provider.statusRefreshPending = false;
  provider.statusRefreshPromise = undefined;
  provider.statusRefreshFailureNotified = false;
  provider.disposed = false;
  provider.diagnostics = { record: () => {} };
  provider.statusRevision = 0;
  provider.projectStatuses = new Map();
  provider.projectPortConflicts = new Map();
  provider.projectOpenPorts = new Map();
  provider.projectRespondingPorts = new Map();
  provider.projectWebPorts = new Map();
  provider.projectServiceUrls = new Map();
  provider.projectRuntime = new Map();
  provider.projectAttemptMetadata = new Map();
  provider.projectTimelineFailures = new Map();
  provider.startReadinessDeadlines = new Map();
  provider.readinessWarnings = new Set();
  provider.httpResponseHistory = { currentTarget: () => undefined };
  provider.renderProjectList = () => {};
  provider.notifyServiceNotReady = () => {};
  provider.recordStartupOutcome = () => {};
  provider.externalServiceUrl = (url) => url;
  return provider;
}

function createDetachedPortReservations(projectId, port) {
  const reservations = new Map([[projectId, 'detached']]);
  const generation = new Map([[port, 'port-token']]);
  return {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(reservations),
    captureShared: (id) => id === projectId ? new Map(generation) : new Map(),
    releaseShared(id, expected) {
      if (id !== projectId || expected?.get(port) !== generation.get(port)) {
        return false;
      }
      reservations.delete(projectId);
      return true;
    },
    release: () => {},
    setState: () => {},
    conflicts: () => []
  };
}

test('fails closed when root-exit ownership cannot transition to detached', async () => {
  const messages = [];
  const Provider = loadRunlistProvider(() => undefined, messages);
  const provider = Object.create(Provider.prototype);
  const child = { pid: 303 };
  const project = {
    id: 'project-1',
    name: 'Project',
    services: [{ name: 'Web', port: 4320 }],
    stopCommand: 'npm stop'
  };
  let portMarked = false;
  const output = [];

  provider.processes = new Map([[project.id, child]]);
  provider.processOwnership = {
    currentOwnership: () => ({ token: 'original-token' }),
    markDetached: () => false,
    snapshot: () => new Map([[project.id, {
      processActive: true,
      state: 'starting',
      token: 'replacement-token'
    }]])
  };
  provider.portReservations = {
    snapshot: () => new Map([[project.id, 'starting']]),
    markDetached: () => {
      portMarked = true;
      return true;
    }
  };
  provider.diagnostics = { record: () => {} };
  provider.managedProjectIds = new Set([project.id]);
  provider.detachedProjectIds = new Set();
  provider.startAttempts = new Map([[project.id, Symbol(project.id)]]);
  provider.projectStatuses = new Map([[project.id, 'starting']]);
  provider.projectRuntime = new Map();
  provider.startReadinessDeadlines = new Map([[project.id, Date.now() + 1000]]);
  provider.readinessWarnings = new Set();
  provider.stoppingProjectIds = new Set();
  provider.statusRevision = 0;
  provider.forgetProjectMetrics = () => {};
  provider.addProjectOutput = (id, message) => output.push([id, message]);
  provider.renderProjectList = () => {};
  provider.refreshProjectStatuses = async () => {};

  await provider.handleProjectProcessExit({
    child,
    code: 0,
    hasServices: true,
    id: project.id,
    launchProject: project,
    project,
    savedProjectRevision: 'revision-1',
    signal: null
  });

  assert.equal(portMarked, false);
  assert.equal(provider.detachedProjectIds.has(project.id), false);
  assert.equal(provider.managedProjectIds.has(project.id), false);
  assert.equal(provider.projectStatuses.get(project.id), 'ownership-lost');
  assert.equal(provider.projectRuntime.get(project.id).token, 'replacement-token');
  assert.match(output[0][1], /could not preserve process ownership/i);
  assert.match(messages[0], /remaining service was left running/i);
});

test('publishes status and runtime from one ownership snapshot per refresh', async () => {
  const messages = [];
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    messages
  );
  let snapshotCalls = 0;
  const owner = {
    reconcileProcessIdentities: async () => {},
    consumeStopRequests: () => [],
    consumeStopRequestFailures: () => [],
    snapshot: () => {
      snapshotCalls += 1;
      return new Map([['project-1', {
        ownerAvailable: snapshotCalls === 1,
        processActive: true,
        state: 'running',
        token: 'ownership-token'
      }]]);
    },
    setState: () => false
  };
  const portReservations = {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    conflicts: () => []
  };
  const provider = createStatusMonitorProvider(Provider, owner, portReservations, []);
  provider.managedProjectIds.clear();

  await provider.refreshProjectStatuses();

  assert.equal(snapshotCalls, 1);
  assert.equal(provider.getProjectStatus('project-1'), 'running');
  assert.equal(provider.projectRuntime.get('project-1').ownerAvailable, true);
  assert.deepEqual(messages, []);
});

test('does not attribute a reused port to an old detached runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-reuse-'));
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: (pid) => [101, 202].includes(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    services: [{ name: 'Web', port: 4320 }]
  });
  const token = owner.snapshot().get('project-1').token;
  owner.recordDetachedServiceListeners('project-1', token, [
    { port: 4320, pid: 404, identity: '404:original' }
  ]);
  owner.markDetached('project-1');

  const portReservations = createDetachedPortReservations('project-1', 4320);
  const messages = [];
  let listenerReads = 0;
  let replacementStable = false;
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    messages,
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => ({ allOpen: true, anyOpen: true, openPorts: [4320] }),
        serviceHttpStatus: async () => ({
          allResponding: true,
          respondingPorts: [4320],
          unresponsivePorts: [],
          webPorts: []
        }),
        reachableServiceUrls: async () => []
      },
      './src/ports/port-process': {
        findListeningProcesses: async () => {
          listenerReads += 1;
          return [!replacementStable && listenerReads === 2
            ? { port: 4320, pid: 404, identity: '404:original' }
            : { port: 4320, pid: 505, identity: '505:replacement' }];
        }
      }
    }
  );
  const provider = createStatusMonitorProvider(Provider, owner, portReservations);
  provider.detachedProjectIds.add('project-1');

  await provider.refreshProjectStatuses();
  assert.equal(owner.snapshot().has('project-1'), true, 'a listener that returns before cleanup must retain the marker');
  assert.equal(portReservations.snapshot().has('project-1'), true);

  replacementStable = true;
  await provider.refreshProjectStatuses();

  assert.deepEqual(messages, []);
  assert.ok(listenerReads >= 4);
  assert.equal(owner.snapshot().has('project-1'), false);
  assert.equal(portReservations.snapshot().has('project-1'), false);
  assert.equal(provider.detachedProjectIds.has('project-1'), false);
  assert.equal(provider.getProjectStatus('project-1'), 'active');
  assert.equal(provider.projectSetupLocked('project-1'), false);
});

test('allows only one detached reconciler and preserves a concurrent custom Stop claim', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-interleave-'));
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    services: [{ name: 'Web', port: 4320 }]
  });
  const token = owner.snapshot().get('project-1').token;
  const original = [{ port: 4320, pid: 404, identity: '404:original' }];
  const replacement = [{ port: 4320, pid: 505, identity: '505:replacement' }];
  owner.recordDetachedServiceListeners('project-1', token, original);
  owner.markDetached('project-1');

  let listenerReads = 0;
  let resolveFinalRead;
  let finalReadStarted;
  const finalReadPromise = new Promise((resolve) => { finalReadStarted = resolve; });
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    [],
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => ({ allOpen: true, anyOpen: true, openPorts: [4320] })
      },
      './src/ports/port-process': {
        findListeningProcesses: async () => {
          listenerReads += 1;
          if (listenerReads <= 2) {
            return replacement;
          }
          finalReadStarted();
          return new Promise((resolve) => { resolveFinalRead = resolve; });
        }
      }
    }
  );
  const portReservations = createDetachedPortReservations('project-1', 4320);
  let releases = 0;
  const releaseShared = portReservations.releaseShared.bind(portReservations);
  portReservations.releaseShared = (...args) => {
    releases += 1;
    return releaseShared(...args);
  };
  const provider = createStatusMonitorProvider(Provider, owner, portReservations);
  const runtime = owner.snapshot();

  const reconciliations = Promise.all([
    provider.reconcileDetachedRuntimeMarkers(runtime),
    provider.reconcileDetachedRuntimeMarkers(runtime)
  ]);
  await finalReadPromise;
  assert.equal(owner.claimDetachedStop('project-1', token), false);
  resolveFinalRead(original);
  await reconciliations;

  assert.equal(releases, 0);
  assert.equal(owner.snapshot().get('project-1').state, 'detached');
  assert.equal(owner.claimDetachedStop('project-1', token).token, token);
  await provider.reconcileDetachedRuntimeMarkers(owner.snapshot());
  assert.equal(releases, 0);
  assert.equal(owner.snapshot().get('project-1').state, 'stopping');
});

test('does not partially release detached ports when one captured generation changes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-generation-'));
  const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-locks-'));
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    isProcessAlive: () => true
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(lockDirectory, { recursive: true, force: true }));
  const services = [
    { name: 'Web', port: 4320 },
    { name: 'API', port: 4321 }
  ];
  owner.reserve('project-1');
  owner.setProcess('project-1', 303, { services });
  const token = owner.snapshot().get('project-1').token;
  const original = [
    { port: 4320, pid: 404, identity: '404:original' },
    { port: 4321, pid: 405, identity: '405:original' }
  ];
  const replacement = [
    { port: 4320, pid: 504, identity: '504:replacement' },
    { port: 4321, pid: 505, identity: '505:replacement' }
  ];
  owner.recordDetachedServiceListeners('project-1', token, original);
  owner.markDetached('project-1');
  const lockPath = (port) => path.join(lockDirectory, `port-${port}.lock`);
  const writeLock = (port, lockToken) => fs.writeFileSync(lockPath(port), JSON.stringify({
    projectId: 'project-1',
    token: lockToken
  }));
  writeLock(4320, 'port-token-1');
  writeLock(4321, 'port-token-2');
  let releaseAttempts = 0;
  const portReservations = {
    captureShared: () => new Map(services.map(({ port }) => {
      const lock = JSON.parse(fs.readFileSync(lockPath(port), 'utf8'));
      return [port, lock.token];
    })),
    withReservationTransaction: (operation) => operation(),
    lockPath,
    releaseSharedUnlocked: () => {
      releaseAttempts += 1;
      return true;
    }
  };
  let listenerReads = 0;
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    [],
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => ({
          allOpen: true,
          anyOpen: true,
          openPorts: [4320, 4321]
        })
      },
      './src/ports/port-process': {
        findListeningProcesses: async () => {
          listenerReads += 1;
          if (listenerReads === 2) {
            writeLock(4321, 'replacement-port-token');
          }
          return replacement;
        }
      }
    }
  );
  const provider = createStatusMonitorProvider(Provider, owner, portReservations, services);

  await provider.reconcileDetachedRuntimeMarkers(owner.snapshot());

  assert.equal(releaseAttempts, 0);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(4320), 'utf8')).token, 'port-token-1');
  assert.equal(JSON.parse(fs.readFileSync(lockPath(4321), 'utf8')).token, 'replacement-port-token');
  assert.equal(owner.snapshot().get('project-1').state, 'detached');
});

test('clears a cross-window detached marker only after verified service disappearance', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detached-missing-'));
  let now = 1000;
  const alive = new Set([101, 202]);
  const owner = new ProcessOwnershipStore(directory, {
    pid: 101,
    now: () => now,
    isProcessAlive: (pid) => alive.has(pid)
  });
  const observer = new ProcessOwnershipStore(directory, {
    pid: 202,
    now: () => now,
    isProcessAlive: (pid) => alive.has(pid)
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  owner.reserve('project-1');
  owner.setProcess('project-1', 303, {
    services: [{ name: 'Web', port: 4320 }]
  });
  const token = owner.snapshot().get('project-1').token;
  const originalListener = { port: 4320, pid: 404, identity: '404:original' };
  owner.recordDetachedServiceListeners('project-1', token, [originalListener]);
  owner.markDetached('project-1');
  const originalHeartbeat = JSON.parse(
    fs.readFileSync(owner.ownershipPath('project-1'), 'utf8')
  ).heartbeatAt;

  let listeners = [originalListener];
  const portReservations = createDetachedPortReservations('project-1', 4320);
  const messages = [];
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    messages,
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => ({ allOpen: false, anyOpen: false, openPorts: [] })
      },
      './src/ports/port-process': {
        findListeningProcesses: async () => listeners
      }
    }
  );
  const provider = createStatusMonitorProvider(Provider, observer, portReservations);

  await provider.refreshProjectStatuses();
  assert.equal(observer.snapshot().has('project-1'), true, 'a transient TCP probe failure must retain the exact listener');
  assert.equal(JSON.parse(
    fs.readFileSync(owner.ownershipPath('project-1'), 'utf8')
  ).heartbeatAt, originalHeartbeat, 'an observing window must not refresh the launch host heartbeat');
  assert.equal(provider.getProjectStatus('project-1'), 'starting');
  assert.equal(provider.projectSetupLocked('project-1'), true);

  listeners = [];
  now = 4000;
  await provider.refreshProjectStatuses();
  assert.equal(observer.snapshot().has('project-1'), true, 'one missing observation must remain protected');

  now = 7000;
  await provider.refreshProjectStatuses();
  assert.deepEqual(messages, []);
  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(portReservations.snapshot().has('project-1'), false);
  assert.equal(provider.detachedProjectIds.has('project-1'), false);
  assert.equal(provider.getProjectStatus('project-1'), 'stopped');
  assert.equal(provider.projectSetupLocked('project-1'), false);
});

test('keeps a live owner through a pending status scan with the real monitoring timers', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-status-monitor-'));
  let now = 1000;
  let resolvePortScan;
  let portScanCalls = 0;
  const alive = new Set([101, 202, 303]);
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
  owner.reserve('project-1');
  owner.setProcess('project-1', 303);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const servicePortStatus = () => {
    portScanCalls += 1;
    if (portScanCalls === 1) {
      return new Promise((resolve) => {
        resolvePortScan = resolve;
      });
    }
    return Promise.resolve({ allOpen: false, anyOpen: false, openPorts: [] });
  };
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    [],
    { './src/lifecycle/project-status': { servicePortStatus } }
  );
  const provider = createStatusMonitorProvider(Provider, owner, {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    conflicts: () => []
  });
  let touchCalls = 0;
  const touchOwned = owner.touchOwned.bind(owner);
  owner.touchOwned = () => {
    touchCalls += 1;
    return touchOwned();
  };
  const intervals = createIntervalHarness();

  try {
    const monitoring = provider.startStatusMonitoring();
    const initialRefresh = provider.statusRefreshPromise;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(portScanCalls, 1);
    assert.equal(provider.statusRefreshInFlight, true);

    intervals.tick(2000, 0);
    assert.equal(provider.statusRefreshPending, true);
    assert.equal(portScanCalls, 1);

    now = 9001;
    intervals.tick(2000, 1);
    assert.equal(touchCalls, 1);
    assert.equal(JSON.parse(fs.readFileSync(owner.ownershipPath('project-1'), 'utf8')).heartbeatAt, now);

    now = 12001;
    assert.equal(observer.snapshot().get('project-1').ownerAvailable, true);
    resolvePortScan({ allOpen: false, anyOpen: false, openPorts: [] });
    await initialRefresh;
    assert.equal(portScanCalls, 2);

    alive.delete(101);
    alive.delete(303);
    now = 18002;
    assert.equal(observer.reserve('project-1'), undefined);
    const replacement = JSON.parse(fs.readFileSync(observer.ownershipPath('project-1'), 'utf8'));
    intervals.tick(2000, 1);
    assert.equal(owner.owns('project-1'), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(observer.ownershipPath('project-1'), 'utf8')),
      replacement
    );

    const touchesBeforeDispose = touchCalls;
    provider.shutdownPromise = Promise.resolve();
    await provider.dispose();
    await provider.dispose();
    intervals.tick(2000);
    assert.equal(touchCalls, touchesBeforeDispose);
    monitoring.dispose();
  } finally {
    intervals.restore();
  }
});

test('reports one background refresh error per failure episode and records recovery', async () => {
  const messages = [];
  const diagnosticEvents = [];
  let shouldFail = true;
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    messages,
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => {
          if (shouldFail) {
            throw Object.assign(new Error('probe unavailable'), { code: 'EPROBE' });
          }
          return { allOpen: false, anyOpen: false, openPorts: [] };
        }
      }
    }
  );
  const owner = {
    reconcileProcessIdentities: async () => {},
    consumeStopRequests: () => [],
    consumeStopRequestFailures: () => [],
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {}
  };
  const provider = createStatusMonitorProvider(Provider, owner, {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    conflicts: () => []
  });
  provider.diagnostics = {
    record: (event, details) => diagnosticEvents.push([event, details?.error?.code])
  };

  await provider.refreshProjectStatuses();
  await provider.refreshProjectStatuses();
  assert.deepEqual(messages, ['Could not refresh Runlist status: probe unavailable']);
  assert.deepEqual(diagnosticEvents, [['status.refresh-failed', 'EPROBE']]);

  shouldFail = false;
  await provider.refreshProjectStatuses();
  assert.deepEqual(diagnosticEvents, [
    ['status.refresh-failed', 'EPROBE'],
    ['status.refresh-recovered', undefined]
  ]);

  shouldFail = true;
  await provider.refreshProjectStatuses();
  assert.equal(messages.length, 2);
  assert.deepEqual(diagnosticEvents.at(-1), ['status.refresh-failed', 'EPROBE']);
});

test('measures event-loop delay during status refreshes', async () => {
  const Provider = loadRunlistProvider(() => ({ on() {}, once() {} }), []);
  const owner = {
    reconcileProcessIdentities: async () => {},
    consumeStopRequests: () => [],
    consumeStopRequestFailures: () => [],
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {}
  };
  const provider = createStatusMonitorProvider(Provider, owner, {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    conflicts: () => []
  });
  const measurements = [];
  provider.diagnostics = {
    measureEventLoopDelay: () => Promise.resolve(125),
    record: () => {},
    recordEventLoopDelay: async (event, measurement) => {
      measurements.push([event, await measurement]);
    }
  };

  await provider.refreshProjectStatuses();

  assert.deepEqual(measurements, [['status.refresh-event-loop-delay', 125]]);
});

test('backs off scheduled refreshes after a failed status probe', async () => {
  let now = 1000;
  let calls = 0;
  let shouldFail = true;
  const originalDateNow = Date.now;
  Date.now = () => now;
  const intervals = createIntervalHarness();
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    [],
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => {
          calls += 1;
          if (shouldFail) {
            throw new Error('probe unavailable');
          }
          return { allOpen: false, anyOpen: false, openPorts: [] };
        }
      }
    }
  );
  const owner = {
    reconcileProcessIdentities: async () => {},
    consumeStopRequests: () => [],
    consumeStopRequestFailures: () => [],
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    touchOwned: () => {}
  };
  const provider = createStatusMonitorProvider(Provider, owner, {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    conflicts: () => []
  });

  try {
    const monitoring = provider.startStatusMonitoring();
    await provider.statusRefreshPromise;
    assert.equal(calls, 1);
    assert.equal(provider.statusRefreshRetryAt, 11000);

    now = 5000;
    intervals.tick(2000, 0);
    await Promise.resolve();
    assert.equal(calls, 1);

    shouldFail = false;
    now = 11000;
    intervals.tick(2000, 0);
    await provider.statusRefreshPromise;
    assert.equal(calls, 2);
    assert.equal(provider.statusRefreshRetryAt, 0);
    monitoring.dispose();
  } finally {
    intervals.restore();
    Date.now = originalDateNow;
  }
});

test('waits for an in-flight status refresh before shutdown cleanup', async () => {
  let releaseProbe;
  let probeStarted;
  const probeStartedPromise = new Promise((resolve) => { probeStarted = resolve; });
  const shutdownCalls = [];
  const Provider = loadRunlistProvider(
    () => ({ on() {}, once() {} }),
    [],
    {
      './src/lifecycle/project-status': {
        servicePortStatus: async () => {
          probeStarted();
          return new Promise((resolve) => { releaseProbe = resolve; });
        }
      },
      './src/lifecycle/project-process': {
        shutdownTrackedProcesses: async () => {
          shutdownCalls.push('cleanup');
          return [];
        }
      }
    }
  );
  const owner = {
    reconcileProcessIdentities: async () => {},
    consumeStopRequests: () => [],
    consumeStopRequestFailures: () => [],
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {}
  };
  const provider = createStatusMonitorProvider(Provider, owner, {
    reconcileProcessIdentities: async () => {},
    snapshot: () => new Map(),
    release: () => {},
    setState: () => {},
    conflicts: () => []
  });
  provider.lifecycle = {
    beginShutdown: () => shutdownCalls.push('begin'),
    waitForIdle: async () => shutdownCalls.push('idle'),
    stop: async () => true
  };
  provider.stopResourceSampling = () => shutdownCalls.push('sampling');
  provider.runGroupCoordinator = { dispose: () => shutdownCalls.push('groups') };
  provider.statusMonitoringDisposable = { dispose: () => shutdownCalls.push('timers') };

  void provider.refreshProjectStatuses();
  await probeStartedPromise;
  const shutdown = provider.dispose();
  await Promise.resolve();
  assert.deepEqual(shutdownCalls, ['timers', 'begin', 'sampling']);

  releaseProbe({ allOpen: false, anyOpen: false, openPorts: [] });
  await shutdown;
  assert.deepEqual(shutdownCalls, [
    'timers',
    'begin',
    'sampling',
    'idle',
    'idle',
    'groups',
    'cleanup'
  ]);
  assert.equal(provider.statusRefreshInFlight, false);
  assert.equal(provider.disposed, true);
});

test('keeps an abandoned host reclaimable without a heartbeat refresh', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-abandoned-host-'));
  let now = 1000;
  const alive = new Set([101, 202, 303]);
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
  alive.delete(101);
  alive.delete(303);
  now = 7001;

  assert.equal(observer.snapshot().has('project-1'), false);
  assert.equal(observer.reserve('project-1'), undefined);
});

test('exposes accessible Restart on the running row and in overflow', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(script, /class="run-button restart" data-action="restart" data-id="\$\{projectId\}" aria-label="Restart \$\{projectName\}"/);
  assert.match(script, /data-action="restart" data-id="\$\{projectId\}" role="menuitem" aria-label="Restart \$\{projectName\}"/);
  assert.match(script, /const detectedWithoutStop = projectStatus === 'active' && !project\.stopCommand/);
  assert.match(script, /\['running', 'not-ready', 'not-responding', 'ownership-lost', 'active'\]\.includes\(projectStatus\)[\s\S]*&& !detectedWithoutStop[\s\S]*&& !ownershipLostWithoutStop/);
  assert.match(script, /\$\{canRestart \? '' : 'disabled'\}/);
  assert.match(script, /data-action="restart"[\s\S]*\$\{icon\('refresh', 'menu-icon'\)\}<span>Restart<\/span>/);
  assert.match(script, /restart: \(\) => vscode\.postMessage\(\{ type: 'restartProject', id: button\.dataset\.id \}\)/);
});

test('waits for a safe Stop to complete before starting again', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => {
      calls.push('stop');
      return true;
    },
    waitForStop: async () => {
      calls.push('wait');
      return true;
    },
    start: async () => {
      calls.push('start');
    }
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ['stop', 'wait', 'start']);
});

test('joins an in-flight Stop instead of rejecting concurrent Restart', async () => {
  const source = readShippedHostSource();
  const lifecycle = fs.readFileSync(path.join(__dirname, '..', 'src', 'lifecycle', 'project-lifecycle.js'), 'utf8');
  assert.match(source, /this\.stoppingOperations = new Map\(\)/);
  assert.match(source, /const existing = this\.stoppingOperations\.get\(id\)/);
  assert.match(source, /async executeStopProjectProcess\(/);
  assert.match(
    lifecycle,
    /\['running', 'not-ready', 'not-responding', 'ownership-lost', 'active', 'stopping'\]/
  );
  assert.doesNotMatch(
    lifecycle,
    /!\['starting', 'stopping'\]\.includes\(sharedState\)/
  );

  let stopCalls = 0;
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const stop = async () => {
    stopCalls += 1;
    await stopGate;
    return true;
  };
  const restarting = new Set();
  const restartPromise = restartProjectSafely(restarting, 'project-1', {
    canRestart: () => true,
    stop,
    waitForStop: async () => true,
    start: async () => true
  });
  const joinedStop = stop();
  releaseStop();
  assert.equal(await restartPromise, true);
  assert.equal(await joinedStop, true);
  assert.equal(stopCalls, 2);
});

test('does not Start when Stop fails', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => {
      calls.push('stop');
      return false;
    },
    waitForStop: async () => {
      calls.push('wait');
      return true;
    },
    start: async () => {
      calls.push('start');
    }
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['stop']);
});

test('does not Start when remote Stop completion cannot be confirmed', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => {
      calls.push('stop');
      return true;
    },
    waitForStop: async () => {
      calls.push('wait');
      return false;
    },
    start: async () => {
      calls.push('start');
    }
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['stop', 'wait']);
});

test('reports Restart failure when the new Start is rejected', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => { calls.push('stop'); return true; },
    waitForStop: async () => { calls.push('wait'); return true; },
    start: async () => { calls.push('start'); return false; }
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['stop', 'wait', 'start']);
});

test('ignores duplicate Restart requests while one is active', async () => {
  const restarting = new Set();
  let releaseStop;
  let starts = 0;
  const actions = {
    stop: () => new Promise((resolve) => {
      releaseStop = resolve;
    }),
    waitForStop: async () => true,
    start: async () => {
      starts += 1;
    }
  };

  const first = restartProjectSafely(restarting, 'project-1', actions);
  assert.equal(await restartProjectSafely(restarting, 'project-1', actions), false);
  releaseStop(true);
  assert.equal(await first, true);
  assert.equal(starts, 1);
  assert.equal(restarting.has('project-1'), false);
});

test('ignores a stale Restart request while a shared transition is active', async () => {
  let stops = 0;
  const result = await restartProjectSafely(new Set(), 'project-1', {
    canRestart: () => false,
    stop: async () => {
      stops += 1;
      return true;
    },
    waitForStop: async () => true,
    start: async () => {}
  });

  assert.equal(result, false);
  assert.equal(stops, 0);
});

test('preserves temporary service ports through a whole-project Restart', async () => {
  const portOverrides = [{
    serviceName: 'api',
    savedPort: 4000,
    port: 4001,
    variable: 'API_PORT'
  }];
  const ownership = {
    ownerAvailable: true,
    processActive: true,
    state: 'running',
    portOverrides
  };
  let stoppedProject;
  let startOptions;
  const host = {
    projects: [{
      id: 'project-1',
      name: 'Project',
      services: [{ name: 'api', port: 4000, portVariable: 'API_PORT' }]
    }],
    processOwnership: { snapshot: () => new Map([['project-1', ownership]]) },
    portReservations: { snapshot: () => new Map([['project-1', 'running']]) },
    restartingProjectIds: new Set(),
    getProjectStatus: () => 'running',
    stopProject: async (id, project) => {
      stoppedProject = project;
      return true;
    },
    waitForProjectStopCompletion: async () => true,
    startProject: async (id, options) => {
      startOptions = options;
      return true;
    }
  };
  const lifecycle = new ProjectLifecycleCoordinator(host);

  assert.equal(await lifecycle.restart('project-1'), true);
  assert.equal(stoppedProject.services[0].port, 4001);
  assert.deepEqual(startOptions, { allowPortConflict: true, portOverrides });
});

test('holds process ownership while deleting a saved project', () => {
  const source = readShippedHostSource();
  const refreshOwnership = source.indexOf('const latestProcessRuntime = this.processOwnership.snapshot()');
  const verifyPortOwnership = source.indexOf('hasUnownedPortReservation(id', refreshOwnership);
  const latestOwnership = source.indexOf('const latestSharedOwnership = latestProcessRuntime.get(id)', verifyPortOwnership);
  const captureDeletionToken = source.indexOf('const deletionOwnershipToken =', latestOwnership);
  const reserveDeletion = source.indexOf('holdForDeletion(id, { expectedToken: deletionOwnershipToken })', captureDeletionToken);
  const removeSavedProject = source.indexOf('removeProject(this.projectsFile, id, { expectedProject: project })', reserveDeletion);
  const releaseDeletion = source.indexOf('this.processOwnership.release(id)', removeSavedProject);

  assert.ok(refreshOwnership >= 0);
  assert.ok(refreshOwnership < verifyPortOwnership);
  assert.ok(verifyPortOwnership < latestOwnership);
  assert.ok(latestOwnership < captureDeletionToken);
  assert.ok(captureDeletionToken < reserveDeletion);
  assert.ok(reserveDeletion < removeSavedProject);
  assert.ok(removeSavedProject < releaseDeletion);
  assert.match(source, /if \(hadTrackedProcess\)[\s\S]*cleanupTrackedProcessForDeletion[\s\S]*this\.processOwnership\.release\(id\)/);
  assert.match(source, /const hadDetachedProcess = this\.detachedProjectIds\.has\(id\)/);
  assert.match(source, /else if \(hadDetachedProcess \|\| latestSharedOwnership\)[\s\S]*this\.stopProject\(id, latestProject\)/);
  assert.match(source, /holdForDeletion\(id, \{ expectedToken: deletionOwnershipToken \}\)/);
  assert.match(source, /running in another VS Code window/);
});

test('prevents service metadata changes while a project is running', () => {
  const extensionSource = readShippedHostSource();
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(extensionSource, /const servicesLocked = existingProject && this\.projectSetupLocked\(projectId\)/);
  assert.match(extensionSource, /if \(servicesChanged\)[\s\S]*this\.processOwnership\.reserve\(projectId\)/);
  assert.match(extensionSource, /if \(servicesReservation\)[\s\S]*this\.processOwnership\.release\(projectId\)/);
  assert.match(extensionSource, /projectSetupLocked\(id, runtime = \{\}\)[\s\S]*projectServicesLocked[\s\S]*hasUnownedPortReservation/);
  assert.match(extensionSource, /servicesLocked: this\.mode === 'edit'[\s\S]*this\.projectSetupLocked\(this\.selectedProjectId\)/);
  assert.match(extensionSource, /this\.getProjectStatus\(project\.id\) === 'active'[\s\S]*this\.projectSetupLocked\(project\.id, lockSnapshot\)/);
  assert.match(webviewSource, /<fieldset id="services"[^>]*\$\{state\.servicesLocked \? 'disabled' : ''\}/);
  assert.match(webviewSource, /Stop this project before changing its services\./);
  assert.match(webviewSource, /project\.openPorts\?\.includes\(service\.port\)/);
});

test('re-reads the saved project after Start acquires process ownership', () => {
  const source = readShippedHostSource();
  const startProject = source.indexOf('async startProject(id, options = {})');
  const reserveOwnership = source.indexOf('this.processOwnership.reserve(id)', startProject);
  const rereadProjects = source.indexOf('projects = this.projects', reserveOwnership);
  const reservePorts = source.indexOf('this.portReservations.reserve(launchProject)', rereadProjects);

  assert.ok(startProject >= 0);
  assert.ok(startProject < reserveOwnership);
  assert.ok(reserveOwnership < rereadProjects);
  assert.ok(rereadProjects < reservePorts);
});

test('does not escalate a custom stop into port or process cleanup', () => {
  const source = readShippedHostSource();
  const stopProject = source.indexOf('async stopProject(id, projectSnapshot, options = {})');
  const customStop = source.indexOf('if (stopProject.stopCommand)', stopProject);
  const confirmCommand = source.indexOf('await this.confirmCustomStopCommand(stopProject)', customStop);
  const verifyPostcondition = source.indexOf('customStopPostcondition({', confirmCommand);
  const customStopEnd = source.indexOf('return this.stopOwnedProjectProcess(id, stopProject, options);', verifyPostcondition);
  const customStopSource = source.slice(customStop, customStopEnd);

  assert.ok(stopProject >= 0);
  assert.ok(customStop < confirmCommand);
  assert.ok(confirmCommand < verifyPostcondition);
  assert.doesNotMatch(customStopSource, /forceCloseProjectPorts|stopOwnedProjectProcess/);
});

test('blocks a custom Stop when the launching owner identity cannot be verified', async () => {
  const messages = [];
  let spawnCalls = 0;
  const Provider = loadRunlistProvider(() => {
    spawnCalls += 1;
    throw new Error('custom Stop must not run');
  }, messages);
  const provider = Object.create(Provider.prototype);
  const project = {
    id: 'project-1',
    name: 'Project',
    folder: process.cwd(),
    stopCommand: 'npm stop',
    services: []
  };
  Object.defineProperty(provider, 'projects', { value: [project] });
  provider.processes = new Map();
  provider.startAttempts = new Map();
  provider.stoppingProjectIds = new Set();
  provider.showLifecycleBlocked = () => true;
  provider.processOwnership = {
    snapshot: () => new Map([['project-1', {
      token: 'ownership-token',
      hostPid: 101,
      state: 'running',
      processActive: true,
      stopCommand: 'npm stop'
    }]]),
    isCurrentOwner: () => false,
    owns: () => false
  };

  assert.equal(await provider.stopProjectProcess('project-1'), false);
  assert.equal(spawnCalls, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /identity could not be verified/i);
});

test('allows a confirmed custom Stop when the launching owner is unavailable', async () => {
  const messages = [];
  let stopCalls = 0;
  const Provider = loadRunlistProvider(() => {}, messages);
  const provider = Object.create(Provider.prototype);
  const project = {
    id: 'project-1',
    name: 'Project One',
    folder: process.cwd(),
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: []
  };
  Object.defineProperty(provider, 'projects', { value: [project] });
  provider.processes = new Map();
  provider.startAttempts = new Map();
  provider.stoppingProjectIds = new Set();
  provider.showLifecycleBlocked = () => true;
  provider.confirmCustomStopCommand = async () => true;
  provider.runCustomStopCommand = async () => {
    stopCalls += 1;
    return { succeeded: true };
  };
  provider.portReservations = { captureShared: () => new Map() };
  provider.waitForProjectStopCompletion = async () => true;
  provider.lifecycle = { waitUntilServicesStopped: async () => true };
  provider.settleCustomStop = () => [];
  provider.processOwnership = {
    snapshot: () => new Map([['project-1', {
      token: 'ownership-token',
      hostPid: 101,
      ownerAvailable: false,
      state: 'running',
      processActive: true,
      stopCommand: 'npm stop'
    }]]),
    owns: () => false
  };

  assert.equal(await provider.stopProjectProcess('project-1'), true);
  assert.equal(stopCalls, 1);
  assert.deepEqual(messages, []);
});

test('revalidates custom Stop ownership after confirmation before running the command', async () => {
  const messages = [];
  let spawnCalls = 0;
  let currentToken = 'ownership-token';
  let currentOwner = true;
  const Provider = loadRunlistProvider(() => {}, messages);
  const provider = Object.create(Provider.prototype);
  const project = {
    id: 'project-1',
    name: 'Project One',
    folder: process.cwd(),
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: []
  };
  Object.defineProperty(provider, 'projects', { value: [project] });
  provider.processes = new Map();
  provider.startAttempts = new Map();
  provider.stoppingProjectIds = new Set();
  provider.showLifecycleBlocked = () => true;
  provider.confirmCustomStopCommand = async () => {
    currentToken = 'replacement-token';
    currentOwner = false;
    return true;
  };
  provider.runCustomStopCommand = async () => {
    spawnCalls += 1;
    return { succeeded: true };
  };
  provider.portReservations = { captureShared: () => new Map() };
  provider.waitForProjectStopCompletion = async () => true;
  provider.lifecycle = { waitUntilServicesStopped: async () => true };
  provider.settleCustomStop = () => [];
  provider.processOwnership = {
    snapshot: () => new Map([['project-1', {
      token: currentToken,
      hostPid: 101,
      state: 'running',
      processActive: true,
      stopCommand: 'npm stop'
    }]]),
    currentOwnership: () => ({
      token: currentToken,
      hostPid: 101,
      state: 'running',
      processActive: true,
      stopCommand: 'npm stop'
    }),
    isCurrentOwner: () => currentOwner,
    owns: () => false
  };

  assert.equal(await provider.stopProjectProcess('project-1'), false);
  assert.equal(spawnCalls, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /identity could not be verified|ownership changed/i);
});

test('verifies the custom stop shell identity before timeout cleanup', () => {
  const source = readShippedHostSource();
  assert.match(
    source,
    /const stopProcessIdentity = Promise\.resolve\(readProcessIdentity\(stopProcess\.pid\)\)[\s\S]*releaseSupervisorIdentityHold\(stopProcess\)/
  );
  assert.match(source, /terminateProcessTree\(stopProcess\.pid, \{[\s\S]*expectedIdentity,[\s\S]*readProcessIdentity/);
});

test('uses the saved custom stop during awaited shutdown without opening a deactivation modal', () => {
  const source = readShippedHostSource();

  assert.match(
    source,
    /const confirmed = options\.approvedLaunchStop === true\s*\|\|\s*isComposeManagedProject\(stopProject\)\s*\|\|\s*await this\.confirmCustomStopCommand\(stopProject\)/
  );
  assert.match(
    source,
    /this\.lifecycle\.stop\(id, \{ \.\.\.project, reviewRequired: false \}, \{\s*approvedLaunchStop: true/
  );
});

test('routes remote custom stops through the launching VS Code window', () => {
  const source = readShippedHostSource();
  const consumeRequests = source.indexOf('this.processOwnership.consumeStopRequests()');
  const dispatchToOwner = source.indexOf('void Promise.resolve(this.stopProject(id, project', consumeRequests);
  const completeRequest = source.indexOf('this.processOwnership.completeStopRequest(id)', dispatchToOwner);
  const stopProject = source.indexOf('async stopProject(id, projectSnapshot, options = {})');
  const sharedOwnership = source.indexOf('const sharedOwnership = this.processOwnership.snapshot().get(id)', stopProject);
  const requestRemoteStop = source.indexOf('return this.stopOwnedProjectProcess(id, stopProject, options);', sharedOwnership);
  const runCustomStop = source.indexOf('customStopResult = await this.runCustomStopCommand(stopProject, {', sharedOwnership);

  assert.ok(consumeRequests >= 0);
  assert.ok(consumeRequests < dispatchToOwner);
  assert.ok(dispatchToOwner < completeRequest);
  assert.ok(stopProject < sharedOwnership);
  assert.ok(sharedOwnership < requestRemoteStop);
  assert.ok(requestRemoteStop < runCustomStop);
});

test('recovers a locally owned process when its in-memory handle is missing', () => {
  const source = readShippedHostSource();
  const localRequest = source.indexOf("if (request.kind === 'local')");
  const recoverOwnedProcess = source.indexOf('this.processOwnership.terminateOwnedProcess(id)', localRequest);
  const finishRecoveredStop = source.indexOf('this.finishOwnedStop(id, project, portGeneration', recoverOwnedProcess);

  assert.ok(localRequest >= 0);
  assert.ok(localRequest < recoverOwnedProcess);
  assert.ok(recoverOwnedProcess < finishRecoveredStop);
});

test('does not mark Stopped until the owned process and configured ports are down', () => {
  const source = readShippedHostSource();
  const finishOwned = source.indexOf('async finishOwnedStop(id, project, portGeneration');
  const nextMethod = source.indexOf('\n  async ', finishOwned + 1);
  const body = source.slice(finishOwned, nextMethod);

  assert.ok(finishOwned >= 0);
  assert.match(body, /waitUntilServicesStopped/);
  assert.match(body, /stopHonestyMessage\(/);
  assert.match(body, /if \(message && processActive\)/);
  assert.match(body, /finishStopping\(id, false\)/);
  assert.match(body, /finishStopping\(id, true, portGeneration\)/);
  assert.match(body, /Port :\$\{port\} is still up|stopHonestyMessage/);
});

test('releases dead process ownership when a configured port remains open', async () => {
  const messages = [];
  const Provider = loadRunlistProvider(() => {}, messages, {
    './src/lifecycle/project-status': {
      servicePortStatus: async () => ({ anyOpen: true, openPorts: [3000] })
    }
  });
  const provider = Object.create(Provider.prototype);
  const project = {
    id: 'project-1',
    name: 'App',
    services: [{ name: 'Web', port: 3000 }]
  };
  const portGeneration = new Map([[3000, 'port-token']]);
  const finishCalls = [];
  provider.lifecycle = { waitUntilServicesStopped: async () => false };
  provider.projectStopFailures = new Map();
  provider.projectStatuses = new Map([['project-1', 'stopping']]);
  provider.finishStopping = (...args) => {
    finishCalls.push(args);
  };
  provider.renderProjectList = () => {};

  assert.equal(
    await provider.finishOwnedStop('project-1', project, portGeneration, {
      processActive: false
    }),
    false
  );
  assert.equal(finishCalls.length, 1);
  assert.equal(finishCalls[0][0], 'project-1');
  assert.equal(finishCalls[0][1], true);
  assert.equal(finishCalls[0][2], portGeneration);
  assert.equal(provider.projectStopFailures.get('project-1'), 'Port :3000 is still up');
  assert.equal(provider.projectStatuses.get('project-1'), 'active');

  finishCalls.length = 0;
  provider.projectStopFailures.clear();
  provider.projectStatuses.set('project-1', 'stopping');
  assert.equal(
    await provider.finishOwnedStop('project-1', project, portGeneration, {
      processActive: true
    }),
    false
  );
  assert.equal(finishCalls.length, 1);
  assert.equal(finishCalls[0][1], false);
  assert.equal(provider.projectStopFailures.get('project-1'), 'Stop failed');
});

test('reports a lost detached Stop claim without executing the custom command', () => {
  const source = readShippedHostSource();
  const claim = source.indexOf('this.processOwnership.claimDetachedStop(id, sharedOwnership.token)');
  const command = source.indexOf('customStopResult = await this.runCustomStopCommand(stopProject, {', claim);
  const claimLost = source.slice(claim, command);

  assert.ok(claim >= 0);
  assert.ok(command > claim);
  assert.match(claimLost, /showWarningMessage\([\s\S]*did not run the Stop command/);
  assert.match(claimLost, /return false;/);
});

test('binds detached Stop success cleanup to the captured ownership and port generations', () => {
  const source = readShippedHostSource();
  const finish = source.indexOf('finishStopping(id, succeeded, portGeneration, detachedStopClaim)');
  const detachedSuccess = source.indexOf('if (detachedStopClaim)', finish);
  const processRelease = source.indexOf('detachedStopClaim.token', detachedSuccess);
  const portRelease = source.indexOf('this.portReservations.releaseShared(id, portGeneration)', detachedSuccess);

  assert.ok(finish >= 0);
  assert.ok(detachedSuccess > finish);
  assert.ok(processRelease > detachedSuccess);
  assert.ok(portRelease > processRelease);
  assert.doesNotMatch(source.slice(finish, processRelease), /const ownership = this\.processOwnership\.snapshot\(\)\.get\(id\)/);
});

test('rolls back detached Stop claims across command and completion probes', () => {
  const source = readShippedHostSource();
  const customStop = source.indexOf('if (stopProject.stopCommand)');
  const command = source.indexOf('customStopResult = await this.runCustomStopCommand(stopProject, {', customStop);
  const completion = source.indexOf('this.waitForProjectStopCompletion(id, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS)', command);
  const serviceProbe = source.indexOf('this.lifecycle.waitUntilServicesStopped(stopProject, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS)', completion);
  const catchBlock = source.indexOf('} catch (error) {', command);
  const rollbackSettlement = source.indexOf('this.settleCustomStop(', catchBlock);

  assert.ok(customStop >= 0);
  assert.ok(command > customStop);
  assert.ok(completion > command);
  assert.ok(serviceProbe > completion);
  assert.ok(catchBlock > serviceProbe);
  assert.ok(rollbackSettlement > catchBlock);
  assert.match(source.slice(command, rollbackSettlement), /settleCustomStop\(/);
  assert.match(source, /rollbackDetachedStop\(\s*id,\s*detachedStopClaim\.token/);
});

test('reports a synchronous custom Stop failure once when settlement cleanup throws', async () => {
  const messages = [];
  const spawnError = new Error('synchronous spawn failure');
  const finishError = new Error('finish cleanup failure');
  const rollbackError = new Error('rollback cleanup failure');
  let observedCleanupErrors;
  Object.defineProperty(spawnError, 'message', {
    configurable: true,
    get() {
      observedCleanupErrors = spawnError.cleanupErrors;
      return 'synchronous spawn failure';
    }
  });
  const Provider = loadRunlistProvider(
    () => { throw spawnError; },
    messages,
    {
      './src/lifecycle/project-process': {
        spawnProjectCommand: () => { throw spawnError; }
      }
    }
  );
  const provider = Object.create(Provider.prototype);
  let finishCalls = 0;
  let rollbackCalls = 0;
  Object.defineProperty(provider, 'projects', { value: [{
    id: 'project-1',
    name: 'Project',
    folder: process.cwd(),
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: []
  }] });
  provider.processes = new Map();
  provider.startAttempts = new Map();
  provider.stoppingProjectIds = new Set();
  provider.projectStatuses = new Map();
  provider.showLifecycleBlocked = () => true;
  provider.confirmCustomStopCommand = async () => true;
  provider.beginStopping = () => {};
  provider.renderProjectList = () => {};
  provider.processOwnership = {
    owns: () => false,
    snapshot: () => new Map([['project-1', {
      detached: true,
      token: 'ownership-token',
      state: 'detached',
      processActive: true,
      stopCommand: 'npm stop'
    }]]),
    claimDetachedStop: () => ({ token: 'ownership-token', priorState: 'detached' }),
    rollbackDetachedStop: () => {
      rollbackCalls += 1;
      throw rollbackError;
    }
  };
  provider.portReservations = {
    captureShared: () => new Map([[4320, 'port-token']]),
    setStateShared: () => {}
  };
  provider.finishStopping = () => {
    finishCalls += 1;
    throw finishError;
  };

  assert.equal(await provider.stopProjectProcess('project-1'), false);
  assert.equal(finishCalls, 1);
  assert.equal(rollbackCalls, 1);
  assert.deepEqual(
    observedCleanupErrors.map((error) => error.message),
    ['finish cleanup failure', 'rollback cleanup failure']
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /synchronous spawn failure/);
  assert.equal(provider.stoppingProjectIds.size, 0);
  assert.equal(provider.projectStatuses.get('project-1'), 'detached');
});

test('reconciles an exact detached generation after success cleanup throws', async () => {
  const messages = [];
  const finishError = new Error('success cleanup failure');
  const Provider = loadRunlistProvider(() => {
    throw new Error('spawn should not run in this branch');
  }, messages);
  const provider = Object.create(Provider.prototype);
  let finishCalls = 0;
  let releaseCalls = 0;
  let claimCalls = 0;
  const ownership = {
    token: 'ownership-token',
    state: 'detached'
  };
  const port = {
    token: 'replacement-port-token',
    state: 'running'
  };
  const capturedPortGeneration = new Map([[4320, 'original-port-token']]);
  Object.defineProperty(provider, 'projects', { value: [{
    id: 'project-1',
    name: 'Project',
    folder: process.cwd(),
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: []
  }] });
  provider.processes = new Map();
  provider.startAttempts = new Map();
  provider.stoppingProjectIds = new Set();
  provider.projectStatuses = new Map([['project-1', 'detached']]);
  provider.showLifecycleBlocked = () => true;
  provider.confirmCustomStopCommand = async () => true;
  provider.beginStopping = () => {
    ownership.state = 'stopping';
    provider.stoppingProjectIds.add('project-1');
  };
  provider.runCustomStopCommand = async () => {
    provider.beginStopping('project-1');
    return { succeeded: true };
  };
  provider.waitForProjectStopCompletion = async () => true;
  provider.renderProjectList = () => {};
  provider.processOwnership = {
    owns: () => false,
    snapshot: () => new Map([['project-1', {
      detached: true,
      token: ownership.token,
      state: ownership.state,
      processActive: true,
      stopCommand: 'npm stop'
    }]]),
    claimDetachedStop: () => {
      claimCalls += 1;
      return { token: 'ownership-token', priorState: 'detached' };
    },
    rollbackDetachedStop: (id, token, state) => {
      if (ownership.token !== token) {
        return false;
      }
      ownership.state = state;
      return true;
    },
    releaseShared: () => {
      releaseCalls += 1;
      throw new Error('destructive release should not run');
    }
  };
  provider.portReservations = {
    captureShared: () => capturedPortGeneration,
    setStateShared: (id, state, generation) => {
      if (generation.get(4320) === port.token) {
        port.state = state;
      }
    }
  };
  provider.lifecycle = {
    waitUntilServicesStopped: async () => true
  };
  provider.finishStopping = () => {
    finishCalls += 1;
    ownership.state = 'stopping';
    throw finishError;
  };

  assert.equal(await provider.stopProjectProcess('project-1'), false);
  assert.equal(finishCalls, 1);
  assert.equal(releaseCalls, 0);
  assert.equal(claimCalls, 1);
  assert.equal(ownership.state, 'detached');
  assert.equal(port.token, 'replacement-port-token');
  assert.equal(port.state, 'running');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /success cleanup failure/);
  assert.equal(provider.stoppingProjectIds.size, 0);
  assert.equal(provider.processOwnership.claimDetachedStop('project-1', ownership.token).token, 'ownership-token');
});

test('captures force-close ownership before recovery and threads it to cleanup', () => {
  const source = readShippedHostSource();
  const forceClose = source.indexOf('async forceCloseProjectPorts(');
  const recovery = source.indexOf('const result = await recoverProjectPorts', forceClose);
  const ownershipCapture = source.indexOf('const detachedOwnership = processRuntime.get(id)?.detached', forceClose);
  const finish = source.indexOf('this.finishStopping(id, true, portGeneration, detachedOwnership)', forceClose);

  assert.ok(forceClose >= 0);
  assert.ok(ownershipCapture > forceClose);
  assert.ok(ownershipCapture < recovery);
  assert.ok(finish > recovery);
});

test('rolls back ownership and start state when port reservation throws', () => {
  const source = readShippedHostSource();
  const reserve = source.indexOf('this.portReservations.reserve(launchProject)');
  const reserveTry = source.lastIndexOf('try {', reserve);
  const startAttempt = source.indexOf('this.startAttempts.set(id, { token: attempt, startedAt: Date.now() })', reserve);
  const showError = source.indexOf('Could not start ${project.name}: ${error.message}', reserve);
  const releaseOwnership = source.indexOf('this.processOwnership.release(id)', reserve);
  const releaseStart = source.indexOf('this.releaseStartReservation(id)', reserve);

  assert.ok(reserve >= 0);
  assert.ok(reserveTry >= 0);
  assert.ok(startAttempt > reserve);
  assert.ok(showError > reserve);
  assert.ok(releaseOwnership > reserve);
  assert.ok(releaseStart > reserve);
  assert.match(source.slice(reserveTry, startAttempt), /try[\s\S]*portReservations\.reserve\(launchProject\)[\s\S]*catch[\s\S]*processOwnership\.release\(id\)[\s\S]*releaseStartReservation\(id\)/);
});

test('keeps start rollback and the original reservation error primary when cleanup throws', () => {
  const source = readShippedHostSource();
  const reserve = source.indexOf('this.portReservations.reserve(launchProject)');
  const startAttempt = source.indexOf('this.startAttempts.set(id, { token: attempt, startedAt: Date.now() })', reserve);
  const rollback = source.slice(source.lastIndexOf('try {', reserve), startAttempt);

  assert.match(rollback, /const cleanupErrors = \[\]/);
  assert.match(rollback, /try[\s\S]*processOwnership\.release\(id\)[\s\S]*catch[\s\S]*cleanupErrors\.push/);
  assert.match(rollback, /try[\s\S]*releaseStartReservation\(id\)[\s\S]*catch[\s\S]*cleanupErrors\.push/);
  assert.match(rollback, /projectStatuses\.set\(id, 'stopped'\)[\s\S]*showErrorMessage\(`Could not start \$\{project\.name\}: \$\{error\.message\}`\)/);
  assert.match(rollback, /error\.cleanupErrors/);
});

test('guards synchronous custom Stop launch failures after beginStopping', () => {
  const source = readShippedHostSource();
  const runCustomStop = source.indexOf('runCustomStopCommand(project, options = {})');
  const beginStopping = source.indexOf('this.beginStopping(project.id, options)', runCustomStop);
  const spawn = source.indexOf('spawnProjectCommand(project.stopCommand', beginStopping);
  const promise = source.indexOf('return new Promise((resolve)', beginStopping);
  const settlement = source.indexOf('settleCustomStop(');

  assert.ok(runCustomStop >= 0);
  assert.ok(beginStopping > runCustomStop);
  assert.ok(spawn > beginStopping);
  assert.ok(promise > spawn);
  assert.match(source.slice(beginStopping, promise), /try[\s\S]*spawnProjectCommand\(project\.stopCommand[\s\S]*catch[\s\S]*return Promise\.reject\(error\)/);
  assert.ok(settlement >= 0);
});

test('does not report an intentional custom-stop exit as a start failure', () => {
  const source = readShippedHostSource();

  assert.match(source, /const stoppedIntentionally = this\.stoppingProjectIds\.has\(id\)/);
  assert.match(source, /const exitDetails = \{[\s\S]*hasCustomStop: Boolean\(launchProject\.stopCommand\)[\s\S]*stoppedIntentionally[\s\S]*\};/);
  assert.match(source, /const detached = startExitDetached\(exitDetails\);[\s\S]*const startFailed = startExitFailed\(exitDetails\);/);
  assert.match(source, /if \(detached\) \{[\s\S]*this\.detachedProjectIds\.add\(id\)[\s\S]*if \(startFailed\) \{[\s\S]*this\.showStartFailure\(/);
});

test('allows remote custom stops enough time for owner polling', () => {
  const source = readShippedHostSource();

  assert.match(source, /const STATUS_POLL_INTERVAL_MS = 2000;/);
  assert.match(source, /const CUSTOM_STOP_TIMEOUT_MS = 15000;/);
  assert.match(source, /const CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS = 20000;/);
  assert.match(source, /const REMOTE_STOP_TIMEOUT_MS = STATUS_POLL_INTERVAL_MS[\s\S]*\+ CUSTOM_STOP_TIMEOUT_MS[\s\S]*\+ CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS[\s\S]*\+ 1000;/);
  assert.match(source, /waitForProjectStopCompletion\(id, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS\)/);
});
