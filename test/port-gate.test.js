const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  occupiedPortsBelongToProject,
  occupiedPortConflict,
  PortReservationStore,
  projectsUsingPort,
  releaseProjectPorts,
  reserveProjectPorts
} = require('../port-gate');

const projects = [
  { id: 'alpha', name: 'Alpha', services: [{ name: 'web', port: 3000 }] },
  { id: 'beta', name: 'Beta', services: [{ name: 'web', port: 3000 }] },
  { id: 'gamma', name: 'Gamma', services: [{ name: 'api', port: 4000 }] }
];

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

test('coordinates reservations across independent extension hosts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstHost = new PortReservationStore(directory, { pid: 101, isProcessAlive: () => true });
  const secondHost = new PortReservationStore(directory, { pid: 202, isProcessAlive: () => true });

  assert.equal(firstHost.reserve(projects[0]), undefined);
  assert.equal(secondHost.snapshot().get('alpha'), 'starting');
  firstHost.setState('alpha', 'running');
  assert.equal(secondHost.snapshot().get('alpha'), 'running');
  assert.deepEqual(secondHost.reserve(projects[1]), { port: 3000, projectId: 'alpha' });
  secondHost.setState('alpha', 'stopping');
  assert.equal(firstHost.snapshot().get('alpha'), 'stopping');
  secondHost.releaseShared('alpha');
  assert.equal(firstHost.snapshot().has('alpha'), false);
  assert.equal(secondHost.reserve(projects[1]), undefined);
  secondHost.dispose();
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
