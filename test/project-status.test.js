const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const {
  areServicesRunning,
  isPortOpen,
  primaryServiceUrl,
  projectStatus,
  servicePortStatus,
  stoppableProjectIds
} = require('../project-status');

test('detects whether configured local service ports are accepting connections', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  assert.equal(await isPortOpen(port), true);
  assert.equal(await areServicesRunning([{ name: 'web', port }]), true);
  assert.deepEqual(await servicePortStatus([{ name: 'web', port }]), {
    allOpen: true,
    anyOpen: true,
    openPorts: [port]
  });

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(await isPortOpen(port), false);
});

test('detects an unmanaged app when all configured service ports are open', () => {
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    managed: false
  }), 'active');
});

test('preserves managed project status', () => {
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    managed: true
  }), 'running');
  assert.equal(projectStatus({
    anyOpen: true,
    hasServices: true,
    managed: true
  }), 'starting');
  assert.equal(projectStatus({
    hasServices: true,
    managed: true,
    withinStartGrace: true
  }), 'starting');
  assert.equal(projectStatus({
    hasServices: true,
    managed: true,
    processActive: true
  }), 'running');
  assert.equal(projectStatus({
    hasServices: true,
    managed: true
  }), 'running');
  assert.equal(projectStatus({ managed: true }), 'running');
  assert.equal(projectStatus({ stopping: true }), 'stopping');
});

test('treats partial unmanaged service availability as active', () => {
  assert.equal(projectStatus({
    allOpen: false,
    anyOpen: true,
    hasServices: true,
    managed: false
  }), 'active');
});

test('reports known and ambiguous port conflicts from refresh-shaped status', () => {
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    knownConflict: true,
    managed: false
  }), 'port-in-use');
  assert.equal(projectStatus({
    allOpen: false,
    anyOpen: true,
    ambiguousConflict: true,
    hasServices: true,
    managed: false
  }), 'port-in-use-unknown');
});

test('uses a safe primary service URL override or derives localhost from its port', () => {
  assert.equal(primaryServiceUrl([{
    name: 'web',
    port: 8787,
    url: 'https://app.local/dashboard?view=all'
  }]), 'https://app.local/dashboard?view=all');
  assert.equal(primaryServiceUrl([{ name: 'web', port: 8787 }]), 'http://127.0.0.1:8787');
  assert.equal(primaryServiceUrl([{ name: 'web', port: 8787, url: 'file:///tmp/app' }]), undefined);
  assert.equal(primaryServiceUrl([]), undefined);
});

test('selects only projects that can be stopped together', () => {
  const projects = [
    { id: 'running', status: 'running' },
    { id: 'starting', status: 'starting' },
    { id: 'active', status: 'active' },
    { id: 'pending-review', status: 'running', reviewRequired: true },
    { id: 'stopping', status: 'stopping' },
    { id: 'stopped', status: 'stopped' },
    { id: 'conflict', status: 'port-in-use' },
    { id: 'unknown-owner', status: 'port-in-use-unknown' }
  ];

  assert.deepEqual(stoppableProjectIds(projects), ['running', 'starting', 'active']);
  assert.deepEqual(stoppableProjectIds(), []);
});
