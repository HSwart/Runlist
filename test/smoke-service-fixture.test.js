const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { projectProcessSpawnOptions, terminateProcessTree } = require('../src/lifecycle/project-process');
const { recoverProjectPorts } = require('../src/ports/port-recovery');
const { terminateListenerProcess } = require('../src/ports/port-process');
const { readRootProcess } = require('../src/lifecycle/process-metrics');

test('root-exit fixture keeps its descendant alive until the scenario releases the root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-root-exit-fixture-'));
  const rootPidPath = path.join(root, 'root.pid');
  const childPidPath = path.join(root, 'child.pid');
  const runCountPath = path.join(root, 'run-count');
  const exitSignalPath = path.join(root, 'exit-now');
  const fixture = spawn(process.execPath, [
    path.join(__dirname, '..', 'smoke', 'fixtures', 'root-exits.js'),
    rootPidPath,
    childPidPath,
    runCountPath,
    exitSignalPath
  ], { stdio: 'ignore' });
  let childPid;

  t.after(async () => {
    for (const pid of [fixture.pid, childPid]) {
      if (processIsAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // The fixture can finish between the liveness check and cleanup.
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await waitFor(
    () => fs.existsSync(rootPidPath) && fs.existsSync(childPidPath),
    'root-exit fixture did not expose its process tree'
  );
  childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(processIsAlive(fixture.pid), true, 'root exited before the scenario released it');
  assert.equal(processIsAlive(childPid), true, 'descendant exited before the root was released');

  fs.writeFileSync(exitSignalPath, 'exit\n');
  await waitFor(() => !processIsAlive(fixture.pid), 'root did not exit after its release signal');
  assert.equal(processIsAlive(childPid), true, 'descendant did not survive the controlled root exit');
});

test('portable ready fixture can create a real child and grandchild process tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-fixture-'));
  const childPidPath = path.join(root, 'child.pid');
  const grandchildPidPath = path.join(root, 'grandchild.pid');
  const port = await availablePort();
  const fixture = spawn(process.execPath, [
    path.join(__dirname, '..', 'smoke', 'fixtures', 'ready.js'),
    root,
    String(port),
    childPidPath,
    grandchildPidPath
  ], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });

  t.after(async () => {
    if (processIsAlive(fixture.pid)) {
      await terminateProcessTree(fixture.pid);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await waitFor(() => fs.existsSync(path.join(root, 'ready.pid')), 'fixture did not become ready');
  await waitFor(
    () => fs.existsSync(childPidPath) && fs.existsSync(grandchildPidPath),
    'fixture did not create its descendant process tree'
  );

  const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  const grandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'));
  assert.equal(processIsAlive(childPid), true);
  assert.equal(processIsAlive(grandchildPid), true);
});

test('zero-port recovery terminates a verified Runlist process tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-zero-port-recovery-'));
  const rootPidPath = path.join(root, 'root.pid');
  const childPidPath = path.join(root, 'child.pid');
  const fixture = spawn(process.execPath, [
    path.join(__dirname, '..', 'smoke', 'fixtures', 'idle.js'),
    rootPidPath,
    childPidPath
  ], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });

  t.after(async () => {
    if (processIsAlive(fixture.pid)) {
      await terminateProcessTree(fixture.pid);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await waitFor(
    () => fs.existsSync(rootPidPath) && fs.existsSync(childPidPath),
    'zero-port fixture did not create its process tree'
  );
  const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  const identity = (await readRootProcess(fixture.pid, process.platform))?.identity;
  assert.equal(typeof identity, 'string', 'zero-port fixture identity was unavailable');

  const result = await recoverProjectPorts({ name: 'Zero-port fixture', services: [] }, 'stop', {
    additionalProcesses: [{
      pid: fixture.pid,
      identity,
      name: 'Zero-port fixture Runlist process',
      ports: [],
      terminateTree: true
    }],
    getOpenPorts: async () => [],
    findListeningProcesses: async () => [],
    confirmPortClosure: async () => true,
    terminateListenerProcess,
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(result, { status: 'closed', openPorts: [], processCount: 1 });
  await waitFor(
    () => !processIsAlive(fixture.pid) && !processIsAlive(childPid),
    'zero-port recovery left part of the Runlist process tree running'
  );
});

test('portable ready fixture can delay service readiness', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-delay-'));
  const port = await availablePort();
  const fixture = spawn(process.execPath, [
    path.join(__dirname, '..', 'smoke', 'fixtures', 'ready.js'),
    root,
    String(port),
    '',
    '',
    '1000'
  ], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });

  t.after(async () => {
    if (processIsAlive(fixture.pid)) {
      await terminateProcessTree(fixture.pid);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  await waitForAsync(() => isPortOpen(port), 'fixture did not become ready after its configured delay');
  assert.ok(
    Date.now() - startedAt >= 800,
    'fixture became ready before its configured delay'
  );
});

test('outer smoke cleanup removes every helper after an injected host abort', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-cleanup-manifest-'));
  const port = await availablePort();
  const fixturePath = path.join(__dirname, '..', 'smoke', 'fixtures', 'ready.js');
  const externalPidPath = path.join(root, 'external.pid');
  const smokeRunner = loadSmokeRunnerForTest();
  const helpers = [];
  const specs = [
    { kind: 'sentinel', args: ['-e', 'setInterval(() => {}, 1000)'], ports: [], terminateTree: false },
    {
      kind: 'external-listener',
      args: [fixturePath, root, String(port), '', '', '0', externalPidPath],
      ports: [port],
      terminateTree: false
    },
    { kind: 'recovery-helper', args: ['-e', 'setInterval(() => {}, 1000)'], ports: [], terminateTree: false }
  ];

  t.after(async () => {
    for (const record of helpers) {
      if (processIsAlive(record.pid)) {
        await smokeRunner.terminateSmokeProcess(record);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let injectedFailure;
  try {
    for (const spec of specs) {
      const helper = spawn(process.execPath, spec.args, {
        stdio: 'ignore',
        ...projectProcessSpawnOptions()
      });
      const record = await smokeRunner.registerSmokeProcess(root, helper, spec);
      helpers.push(record);
      if (spec.kind === 'external-listener') {
        await waitFor(() => fs.existsSync(externalPidPath), 'external listener fixture did not become ready');
      }
    }
    throw new Error('injected host abort after partial helper registration');
  } catch (error) {
    injectedFailure = error;
  }

  assert.match(injectedFailure?.message || '', /injected host abort/);
  const registered = smokeRunner.readSmokeProcessManifest(root);
  assert.deepEqual(registered.map((record) => record.kind).sort(), [
    'external-listener',
    'recovery-helper',
    'sentinel'
  ]);
  const attempted = [];
  assert.deepEqual(await smokeRunner.cleanupExactFixtureProcesses(root, {
    terminateProcess: async (record) => {
      attempted.push(record);
      return smokeRunner.terminateSmokeProcess(record);
    }
  }), []);
  assert.deepEqual(attempted.map((record) => record.pid).sort(), helpers.map((record) => record.pid).sort());
  assert.equal(attempted.every((record) => typeof record.identity === 'string'), true);
  assert.equal(
    smokeRunner.readSmokeProcessManifest(root).every((record) => record.state === 'exited'),
    true,
    'outer cleanup did not mark all verified helper exits'
  );
  assert.equal(await isPortOpen(port), false, 'outer cleanup left the helper listener port open');
  assert.equal(helpers.every((record) => !processIsAlive(record.pid)), true);
});

test('registration failure never signals a helper without verified identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-registration-failure-'));
  const smokeRunner = loadSmokeRunnerForTest();
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });
  const knownIdentity = (await readRootProcess(helper.pid, process.platform))?.identity;
  const knownRecord = { pid: helper.pid, identity: knownIdentity, terminateTree: false };
  t.after(async () => {
    if (knownRecord.identity && processIsAlive(knownRecord.pid)) {
      await smokeRunner.terminateSmokeProcess(knownRecord);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let signalCount = 0;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (signal !== 0) {
      signalCount += 1;
    }
    return originalKill(pid, signal);
  };
  try {
    await assert.rejects(
      smokeRunner.registerSmokeProcess(
        root,
        helper,
        { kind: 'identity-failure', terminateTree: false },
        { readProcessIdentity: async () => undefined, identityTimeoutMs: 1 }
      ),
      /stable process identity/
    );
    await assert.rejects(
      smokeRunner.cleanupSmokeProcess(root, helper, undefined, 'registration failure'),
      /could not be cleaned.*no signal was sent/i
    );
  } finally {
    process.kill = originalKill;
  }
  assert.equal(signalCount, 0, 'registration failure used a PID-only signal');
  assert.equal(processIsAlive(helper.pid), true, 'registration failure unexpectedly signaled the helper');
});

test('outer cleanup leaves a replacement helper running when identity changes at termination', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-identity-race-'));
  const smokeRunner = loadSmokeRunnerForTest();
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });
  const identity = (await readRootProcess(helper.pid, process.platform))?.identity;
  assert.equal(typeof identity, 'string', 'identity-race fixture identity was unavailable');
  const record = { pid: helper.pid, identity, kind: 'identity-race', ports: [], terminateTree: false, state: 'running' };
  fs.writeFileSync(path.join(root, 'fixture-identities.json'), JSON.stringify([record]));
  let alive = true;
  let reads = 0;
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === helper.pid) {
      if (signal === 0) {
        return alive;
      }
      signals.push([pid, signal]);
      alive = false;
      return;
    }
    return originalKill(pid, signal);
  };
  t.after(async () => {
    process.kill = originalKill;
    if (processIsAlive(helper.pid)) {
      originalKill(helper.pid, 'SIGTERM');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const remaining = await smokeRunner.cleanupExactFixtureProcesses(root, {
    terminateProcess: (processRecord) => smokeRunner.terminateSmokeProcess(processRecord, {
      readProcessIdentity: async () => (++reads === 1 ? identity : 'replacement-identity')
    })
  });

  assert.deepEqual(signals, [], 'replacement helper received a termination signal');
  assert.deepEqual(remaining, [helper.pid]);
  assert.match(
    smokeRunner.readSmokeProcessManifest(root)[0].cleanupError || '',
    /changed helper identity|identity changed/i
  );
});

test('smoke termination retries transient unavailable Windows identities before signaling', async (t) => {
  const smokeRunner = loadSmokeRunnerForTest();
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });
  const identity = '404:638912345678901234';
  const record = {
    pid: helper.pid,
    identity,
    kind: 'unavailable-retry',
    ports: [],
    terminateTree: false,
    state: 'running'
  };
  let reads = 0;
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === helper.pid) {
      if (signal === 0) {
        return true;
      }
      signals.push([pid, signal]);
      return;
    }
    return originalKill(pid, signal);
  };
  t.after(() => {
    process.kill = originalKill;
    try {
      originalKill(helper.pid, 'SIGTERM');
    } catch {
      // Helper may already be gone after a successful exact stop.
    }
  });

  await smokeRunner.terminateSmokeProcess(record, {
    platform: 'win32',
    identityRetryDelayMs: 0,
    readProcessIdentity: async () => {
      reads += 1;
      return reads < 3 ? undefined : identity;
    },
    kill: (pid) => {
      signals.push([pid, 'kill']);
      originalKill(helper.pid, 'SIGTERM');
    }
  });

  assert.equal(reads, 4, 'expected three verification reads plus one pre-kill read');
  assert.deepEqual(signals, [[helper.pid, 'kill']]);
});

test('smoke termination reports unavailable helper identity without signaling', async (t) => {
  const smokeRunner = loadSmokeRunnerForTest();
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });
  const record = {
    pid: helper.pid,
    identity: '404:638912345678901234',
    kind: 'unavailable-identity',
    ports: [],
    terminateTree: false,
    state: 'running'
  };
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === helper.pid && signal !== 0) {
      signals.push([pid, signal]);
    }
    return originalKill(pid, signal);
  };
  t.after(() => {
    process.kill = originalKill;
    try {
      originalKill(helper.pid, 'SIGTERM');
    } catch {
      // Helper may already be gone.
    }
  });

  await assert.rejects(
    () => smokeRunner.terminateSmokeProcess(record, {
      platform: 'win32',
      identityAttempts: 2,
      identityRetryDelayMs: 0,
      readProcessIdentity: async () => undefined
    }),
    /could not re-verify helper identity/i
  );
  assert.deepEqual(signals, []);
});

test('smoke termination treats an already-exited helper as cleaned when identity is unavailable', async (t) => {
  const smokeRunner = loadSmokeRunnerForTest();
  const record = {
    pid: 404404,
    identity: '404404:638912345678901234',
    kind: 'already-exited',
    ports: [],
    terminateTree: false,
    state: 'running'
  };
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === record.pid && signal !== 0) {
      signals.push([pid, signal]);
    }
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  };
  t.after(() => {
    process.kill = originalKill;
  });

  await smokeRunner.terminateSmokeProcess(record, {
    platform: 'win32',
    identityAttempts: 2,
    identityRetryDelayMs: 0,
    readProcessIdentity: async () => undefined
  });
  assert.deepEqual(signals, []);
});

test('outer cleanup recovers a valid backup without overwriting corrupt manifest evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-manifest-recovery-'));
  const smokeRunner = loadSmokeRunnerForTest();
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    ...projectProcessSpawnOptions()
  });
  const identity = (await readRootProcess(helper.pid, process.platform))?.identity;
  const record = { pid: helper.pid, identity, kind: 'backup-helper', ports: [], terminateTree: false, state: 'running' };
  const manifestPath = path.join(root, 'fixture-identities.json');
  const backupPath = `${manifestPath}.bak`;
  const corruptContents = '{not-json';
  fs.writeFileSync(manifestPath, corruptContents);
  fs.writeFileSync(backupPath, JSON.stringify([record]));
  t.after(async () => {
    if (record.identity && processIsAlive(record.pid)) {
      await smokeRunner.terminateSmokeProcess(record);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(smokeRunner.readSmokeProcessManifest(root), [record]);
  assert.equal(fs.readFileSync(`${manifestPath}.corrupt`, 'utf8'), corruptContents);
  const attempted = [];
  assert.deepEqual(await smokeRunner.cleanupExactFixtureProcesses(root, {
    terminateProcess: async (processRecord) => {
      attempted.push(processRecord);
      return smokeRunner.terminateSmokeProcess(processRecord);
    }
  }), []);
  assert.deepEqual(attempted.map((processRecord) => processRecord.pid), [record.pid]);
  assert.equal(processIsAlive(record.pid), false);
});

test('outer cleanup fails visibly when both manifest copies are corrupt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-manifest-corrupt-'));
  const smokeRunner = loadSmokeRunnerForTest();
  const manifestPath = path.join(root, 'fixture-identities.json');
  fs.writeFileSync(manifestPath, '{not-json');
  fs.writeFileSync(`${manifestPath}.bak`, '[also-not-valid]');
  try {
    await assert.rejects(
      smokeRunner.cleanupExactFixtureProcesses(root),
      /Smoke process manifest is corrupt and no valid backup exists/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic identity corruption recovers a valid backup without suppressing evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-manifest-semantic-recovery-'));
  const smokeRunner = loadSmokeRunnerForTest();
  const manifestPath = path.join(root, 'fixture-identities.json');
  const invalidPrimary = [{ pid: 10101, identity: '   ', kind: 'invalid-primary', ports: [], terminateTree: false }];
  const validBackup = [{ pid: 20202, identity: '20202:stable', kind: 'valid-backup', ports: [], terminateTree: false }];
  fs.writeFileSync(manifestPath, JSON.stringify(invalidPrimary));
  fs.writeFileSync(`${manifestPath}.bak`, JSON.stringify(validBackup));
  try {
    assert.deepEqual(smokeRunner.readSmokeProcessManifest(root), validBackup);
    assert.equal(fs.readFileSync(`${manifestPath}.corrupt`, 'utf8'), JSON.stringify(invalidPrimary));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic corruption in both manifest copies fails visibly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-manifest-semantic-corrupt-'));
  const smokeRunner = loadSmokeRunnerForTest();
  const manifestPath = path.join(root, 'fixture-identities.json');
  fs.writeFileSync(manifestPath, JSON.stringify([{ pid: 30303, identity: '', kind: 'invalid-primary' }]));
  fs.writeFileSync(`${manifestPath}.bak`, JSON.stringify([{ pid: 40404, identity: '\t', kind: 'invalid-backup' }]));
  try {
    await assert.rejects(
      smokeRunner.cleanupExactFixtureProcesses(root),
      /Smoke process manifest is corrupt and no valid backup exists/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function loadSmokeRunnerForTest() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '@vscode/test-electron') {
      return { runTests: async () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../smoke/run');
  } finally {
    Module._load = originalLoad;
  }
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(100);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', unavailable);
    socket.once('timeout', unavailable);
  });
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function waitForAsync(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
