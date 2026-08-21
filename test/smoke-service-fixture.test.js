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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
