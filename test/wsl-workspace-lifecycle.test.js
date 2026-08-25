const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  detectLifecycleCapability,
  projectLifecycleCapability
} = require('../src/lifecycle/lifecycle-capability');
const {
  currentProcessIdentity,
  processIdentityDecision,
  stableProcessIdentity
} = require('../src/lifecycle/process-identity');
const { PortReservationStore } = require('../src/ports/port-gate');
const {
  portClosureConfirmation,
  recoverProjectPorts
} = require('../src/ports/port-recovery');

const linuxProject = {
  id: 'wsl-app',
  name: 'WSL App',
  folder: '/home/me/app',
  services: [{ name: 'Web', port: 4173 }]
};

test('Remote WSL workspace Start/Stop identity stays on Linux', {
  skip: process.platform !== 'linux' ? 'requires a Linux workspace host' : false
}, () => {
  const capability = detectLifecycleCapability({
    remoteName: 'wsl',
    platform: 'linux',
    extensionKind: 'workspace'
  });
  assert.equal(capability.supported, true);
  assert.equal(projectLifecycleCapability(capability, {
    folder: '/home/me/app'
  }, 'linux').supported, true);
  assert.equal(projectLifecycleCapability(capability, {
    folder: '\\\\wsl$\\Ubuntu\\home\\me\\app'
  }, 'win32').supported, false);

  const identity = currentProcessIdentity({ platform: 'linux', allowRuntimeFallback: true });
  assert.equal(stableProcessIdentity(identity), true);
  assert.match(String(identity), /:linux:|:runtime:/);
  assert.equal(
    processIdentityDecision(identity, identity, 'linux', process.pid, { allowRuntime: true }),
    'match'
  );
  assert.equal(
    processIdentityDecision(
      `${process.pid}:linux:99`,
      `${process.pid}:2024-01-01T00:00:00:windows-host`,
      'linux',
      process.pid
    ),
    'unavailable'
  );
  assert.notEqual(
    processIdentityDecision(
      `${process.pid}:linux:99`,
      `${process.pid}:2024-01-01T00:00:00:windows-host`,
      'win32',
      process.pid
    ),
    'match'
  );

  const listed = spawnSync('ps', ['-p', String(process.pid), '-o', 'pid='], {
    encoding: 'utf8'
  });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, new RegExp(String(process.pid)));
});

test('Remote WSL port reservations stay isolated from a Windows host identity', {
  skip: process.platform !== 'linux' ? 'requires a Linux workspace host' : false
}, (t) => {
  const linuxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-wsl-linux-ports-'));
  const windowsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-wsl-windows-ports-'));
  t.after(() => {
    fs.rmSync(linuxRoot, { recursive: true, force: true });
    fs.rmSync(windowsRoot, { recursive: true, force: true });
  });

  const linuxHost = new PortReservationStore(linuxRoot, {
    pid: 4242,
    platform: 'linux',
    hostIdentity: '4242:linux:1001',
    isProcessAlive: () => true
  });
  const windowsHost = new PortReservationStore(windowsRoot, {
    pid: 4242,
    platform: 'win32',
    hostIdentity: '4242:2024-01-01T00:00:00:windows-host',
    isProcessAlive: () => true
  });

  assert.equal(linuxHost.reserve(linuxProject), undefined);
  assert.equal(windowsHost.reserve(linuxProject), undefined);
  assert.equal(linuxHost.snapshot().get('wsl-app'), 'starting');
  assert.equal(windowsHost.snapshot().get('wsl-app'), 'starting');

  const linuxLock = JSON.parse(fs.readFileSync(path.join(linuxRoot, 'port-4173.lock'), 'utf8'));
  const windowsLock = JSON.parse(fs.readFileSync(path.join(windowsRoot, 'port-4173.lock'), 'utf8'));
  assert.equal(linuxLock.hostIdentity, '4242:linux:1001');
  assert.equal(linuxLock.platform, 'linux');
  assert.equal(windowsLock.hostIdentity, '4242:2024-01-01T00:00:00:windows-host');
  assert.equal(windowsLock.platform, 'win32');
  assert.notEqual(linuxLock.hostIdentity, windowsLock.hostIdentity);
  assert.equal(fs.existsSync(path.join(linuxRoot, 'port-4173.lock')), true);
  assert.equal(fs.existsSync(path.join(windowsRoot, 'port-4173.lock')), true);
});

test('Remote WSL external-listener close shows exact port and PID, then revalidates identity', {
  skip: process.platform !== 'linux' ? 'requires a Linux workspace host' : false
}, async () => {
  const confirmation = portClosureConfirmation(linuxProject, 'start', [4173], [
    { pid: 8811, identity: '8811:linux:44', name: 'node', ports: [4173] }
  ]);
  assert.match(confirmation.detail, /Web :4173 — node \(PID 8811\)/);

  const terminated = [];
  let listenerIdentity = '8811:linux:44';
  const changed = await recoverProjectPorts(linuxProject, 'start', {
    getOpenPorts: async () => [4173],
    findListeningProcesses: async () => [
      { port: 4173, pid: 8811, identity: listenerIdentity, name: 'node' }
    ],
    confirmPortClosure: async ({ openPorts, processes }) => {
      assert.deepEqual(openPorts, [4173]);
      assert.equal(processes[0].pid, 8811);
      listenerIdentity = '8811:linux:99';
      return true;
    },
    terminateListenerProcess: async (processInfo) => {
      terminated.push(processInfo.pid);
    },
    waitForPortsClosed: async () => true
  });
  assert.equal(changed.status, 'changed');
  assert.deepEqual(terminated, []);

  const closed = await recoverProjectPorts(linuxProject, 'start', {
    getOpenPorts: async () => [4173],
    findListeningProcesses: async () => [
      { port: 4173, pid: 8811, identity: '8811:linux:44', name: 'node' }
    ],
    confirmPortClosure: async () => true,
    terminateListenerProcess: async (processInfo) => {
      terminated.push(processInfo.pid);
    },
    waitForPortsClosed: async () => true
  });
  assert.equal(closed.status, 'closed');
  assert.deepEqual(terminated, [8811]);
});
