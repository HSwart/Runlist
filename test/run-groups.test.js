const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readRunGroups,
  removeProject,
  removeRunGroup,
  upsertProject,
  upsertRunGroup
} = require('../src/projects/project-store');
const {
  RunGroupCoordinator,
  runGroupManagementWorkflow,
  startRunGroup,
  stopRunGroup
} = require('../src/groups/run-groups');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-groups-'));
  const projectsFile = path.join(root, 'storage', 'projects.json');
  const firstFolder = path.join(root, 'first');
  const secondFolder = path.join(root, 'second');
  fs.mkdirSync(firstFolder, { recursive: true });
  fs.mkdirSync(secondFolder);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = upsertProject(projectsFile, {
    name: 'First',
    folder: firstFolder,
    startCommand: 'npm run first'
  }).project;
  const second = upsertProject(projectsFile, {
    name: 'Second',
    folder: secondFolder,
    startCommand: 'npm run second'
  }).project;
  return { first, projectsFile, root, second };
}

test('persists create, rename, ordered edit, and removal for run groups', (t) => {
  const { first, projectsFile, second } = fixture(t);

  const created = upsertRunGroup(projectsFile, {
    name: 'Daily apps',
    projectIds: [second.id, first.id]
  });
  assert.deepEqual(readRunGroups(projectsFile), [{
    id: created.group.id,
    name: 'Daily apps',
    projectIds: [second.id, first.id],
    startMode: 'sequential'
  }]);

  upsertRunGroup(projectsFile, {
    id: created.group.id,
    name: 'Morning apps',
    projectIds: [first.id]
  });
  assert.deepEqual(readRunGroups(projectsFile)[0], {
    id: created.group.id,
    name: 'Morning apps',
    projectIds: [first.id],
    startMode: 'sequential'
  });

  assert.equal(removeRunGroup(projectsFile, created.group.id), true);
  assert.deepEqual(readRunGroups(projectsFile), []);
});

test('rejects stale run-group edits and removal across windows', (t) => {
  const { first, projectsFile, second } = fixture(t);
  const original = upsertRunGroup(projectsFile, {
    name: 'Daily apps',
    projectIds: [first.id]
  }).group;
  const changed = upsertRunGroup(projectsFile, {
    ...original,
    projectIds: [first.id, second.id]
  }, { expectedGroup: original }).group;

  assert.throws(() => upsertRunGroup(projectsFile, {
    ...original,
    name: 'Stale rename'
  }, { expectedGroup: original }), (error) => error.code === 'STALE_GROUP');
  assert.throws(() => removeRunGroup(projectsFile, original.id, {
    expectedGroup: original
  }), (error) => error.code === 'STALE_GROUP');
  assert.deepEqual(readRunGroups(projectsFile), [changed]);
});

test('removing a project prunes only its memberships', (t) => {
  const { first, projectsFile, second } = fixture(t);
  upsertRunGroup(projectsFile, {
    name: 'Both',
    projectIds: [first.id, second.id]
  });
  upsertRunGroup(projectsFile, {
    name: 'Second only',
    projectIds: [second.id]
  });

  assert.equal(removeProject(projectsFile, first.id), true);
  assert.deepEqual(readRunGroups(projectsFile).map((group) => ({
    name: group.name,
    projectIds: group.projectIds
  })), [
    { name: 'Both', projectIds: [second.id] },
    { name: 'Second only', projectIds: [second.id] }
  ]);

  assert.equal(removeProject(projectsFile, second.id), true);
  assert.deepEqual(readRunGroups(projectsFile), []);
});

test('drops legacy empty groups instead of treating a no-op start as valid', (t) => {
  const { first, projectsFile } = fixture(t);
  const created = upsertRunGroup(projectsFile, {
    name: 'Temporary',
    projectIds: [first.id]
  }).group;
  const document = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  document.groups.find((group) => group.id === created.id).projectIds = [];
  fs.writeFileSync(projectsFile, JSON.stringify(document));

  assert.deepEqual(readRunGroups(projectsFile), []);
});

test('removing the last project removes the run group after reload', (t) => {
  const { first, projectsFile } = fixture(t);
  const group = upsertRunGroup(projectsFile, {
    name: 'Only app',
    projectIds: [first.id]
  }).group;

  assert.equal(removeProject(projectsFile, first.id), true);
  assert.deepEqual(readRunGroups(projectsFile), []);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(projectsFile, 'utf8')), 'groups'), false);
  assert.equal(group.projectIds.length, 1);
});

test('cleans up legacy persisted empty groups on reload', (t) => {
  const { first, projectsFile } = fixture(t);
  const document = {
    schemaVersion: 5,
    projects: [first],
    groups: [{
      id: 'legacy-empty',
      name: 'Legacy empty',
      projectIds: [],
      startMode: 'parallel'
    }]
  };
  fs.writeFileSync(projectsFile, `${JSON.stringify(document, null, 2)}\n`);

  assert.deepEqual(readRunGroups(projectsFile), []);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(projectsFile, 'utf8')), 'groups'), false);
});

test('persists and preserves a parallel run-group start mode', (t) => {
  const { first, projectsFile, second } = fixture(t);
  const created = upsertRunGroup(projectsFile, {
    name: 'Parallel apps',
    projectIds: [first.id, second.id],
    startMode: 'parallel'
  });

  upsertRunGroup(projectsFile, {
    id: created.group.id,
    name: 'Renamed parallel apps',
    projectIds: [second.id, first.id]
  });

  assert.equal(readRunGroups(projectsFile)[0].startMode, 'parallel');
  assert.throws(() => upsertRunGroup(projectsFile, {
    id: created.group.id,
    name: 'Invalid',
    projectIds: [first.id],
    startMode: 'automatic'
  }), /sequential or parallel/);
});

test('starts members sequentially and waits for readiness before advancing', async () => {
  const events = [];
  const statuses = new Map([['first', 'stopped'], ['second', 'stopped']]);
  const result = await startRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['first', 'second']
  }, {
    coordinator: { acquire: () => true, release: () => {} },
    projects: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
    getStatus: (id) => statuses.get(id),
    startProject: async (id) => {
      events.push(`start:${id}`);
      statuses.set(id, 'starting');
      return true;
    },
    waitUntilReady: async (id) => {
      events.push(`ready:${id}`);
      statuses.set(id, 'running');
      return true;
    },
    stopProject: async () => true,
    waitUntilStopped: async () => true
  });

  assert.equal(result.status, 'started');
  assert.deepEqual(result.startedProjectIds, ['first', 'second']);
  assert.deepEqual(events, ['start:first', 'ready:first', 'start:second', 'ready:second']);
});

test('rolls back a sequential start when its cross-window lease is lost', async () => {
  const calls = [];
  let leaseHeld = true;
  const result = await startRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['first', 'second']
  }, {
    coordinator: {
      acquire: () => true,
      hasLease: () => leaseHeld,
      release: () => calls.push('release')
    },
    projects: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
    getStatus: () => 'stopped',
    startProject: async (id) => {
      calls.push(`start:${id}`);
      leaseHeld = false;
      return true;
    },
    waitUntilReady: async (id) => {
      calls.push(`ready:${id}`);
      return true;
    },
    stopProject: async (id) => {
      calls.push(`stop:${id}`);
      return true;
    },
    waitUntilStopped: async (id) => {
      calls.push(`stopped:${id}`);
      return true;
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failedProjectId, 'first');
  assert.equal(result.failureReason, 'Runlist lost cross-window coordination for this group.');
  assert.deepEqual(result.startedProjectIds, ['first']);
  assert.deepEqual(calls, ['start:first', 'stop:first', 'stopped:first', 'release']);
});

test('rolls back only newly started members in reverse after a blocked start', async () => {
  const calls = [];
  const statuses = new Map([
    ['existing', 'running'],
    ['started', 'stopped'],
    ['blocked', 'stopped']
  ]);
  const result = await startRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['existing', 'started', 'blocked']
  }, {
    coordinator: { acquire: () => true, release: () => calls.push('release') },
    projects: [
      { id: 'existing', name: 'Existing' },
      { id: 'started', name: 'Started' },
      { id: 'blocked', name: 'Blocked' }
    ],
    getStatus: (id) => statuses.get(id),
    startProject: async (id) => {
      calls.push(`start:${id}`);
      if (id === 'blocked') {
        return false;
      }
      statuses.set(id, 'starting');
      return true;
    },
    waitUntilReady: async (id) => {
      calls.push(`ready:${id}`);
      statuses.set(id, 'running');
      return true;
    },
    stopProject: async (id) => {
      calls.push(`stop:${id}`);
      statuses.set(id, 'stopping');
      return true;
    },
    waitUntilStopped: async (id) => {
      calls.push(`stopped:${id}`);
      return true;
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failedProjectId, 'blocked');
  assert.deepEqual(result.startedProjectIds, ['started']);
  assert.deepEqual(calls, [
    'start:started',
    'ready:started',
    'start:blocked',
    'stop:started',
    'stopped:started',
    'release'
  ]);
});

test('starts eligible parallel members together and rolls back started members in reverse saved order', async () => {
  const calls = [];
  const readyResolvers = new Map();
  const readiness = (id) => new Promise((resolve) => readyResolvers.set(id, resolve));
  const run = startRunGroup({
    id: 'parallel',
    name: 'Parallel',
    projectIds: ['existing', 'first', 'second'],
    startMode: 'parallel'
  }, {
    coordinator: { acquire: () => true, release: () => calls.push('release') },
    projects: [
      { id: 'existing', name: 'Existing' },
      { id: 'first', name: 'First' },
      { id: 'second', name: 'Second' }
    ],
    getStatus: (id) => id === 'existing' ? 'running' : 'stopped',
    startProject: async (id) => {
      calls.push(`start:${id}`);
      return true;
    },
    waitUntilReady: async (id) => {
      const ready = await readiness(id);
      calls.push(`ready:${id}`);
      return ready;
    },
    stopProject: async (id) => {
      calls.push(`stop:${id}`);
      return true;
    },
    waitUntilStopped: async (id) => {
      calls.push(`stopped:${id}`);
      return true;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start:first', 'start:second']);
  readyResolvers.get('second')(false);
  readyResolvers.get('first')(true);
  const result = await run;

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.startedProjectIds, ['first', 'second']);
  assert.deepEqual(result.failedProjectIds, ['second']);
  assert.deepEqual(calls.slice(2), [
    'ready:second',
    'ready:first',
    'stop:second',
    'stopped:second',
    'stop:first',
    'stopped:first',
    'release'
  ]);
});

test('does not launch remaining parallel members after losing the group lease', async () => {
  const calls = [];
  let leaseHeld = true;
  const result = await startRunGroup({
    id: 'parallel',
    name: 'Parallel',
    projectIds: ['first', 'second'],
    startMode: 'parallel'
  }, {
    coordinator: {
      acquire: () => true,
      hasLease: () => leaseHeld,
      release: () => calls.push('release')
    },
    projects: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
    getStatus: () => 'stopped',
    startProject: async (id) => {
      calls.push(`start:${id}`);
      leaseHeld = false;
      return true;
    },
    waitUntilReady: async (id) => {
      calls.push(`ready:${id}`);
      return true;
    },
    stopProject: async (id) => {
      calls.push(`stop:${id}`);
      return true;
    },
    waitUntilStopped: async (id) => {
      calls.push(`stopped:${id}`);
      return true;
    }
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.startedProjectIds, ['first']);
  assert.deepEqual(result.failedProjectIds, ['first', 'second']);
  assert.deepEqual(calls, ['start:first', 'stop:first', 'stopped:first', 'release']);
});

test('parallel preflight starts nothing when any member is unsafe', async () => {
  const starts = [];
  const result = await startRunGroup({
    id: 'parallel',
    name: 'Parallel',
    projectIds: ['first', 'blocked'],
    startMode: 'parallel'
  }, {
    coordinator: { acquire: () => true, release: () => {} },
    projects: [{ id: 'first', name: 'First' }, { id: 'blocked', name: 'Blocked' }],
    getStatus: (id) => id === 'blocked' ? 'port-in-use' : 'stopped',
    startProject: async (id) => {
      starts.push(id);
      return true;
    },
    waitUntilReady: async () => true,
    stopProject: async () => true,
    waitUntilStopped: async () => true
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failedProjectId, 'blocked');
  assert.deepEqual(starts, []);
});

test('stops only Runlist-owned members in reverse order', async () => {
  const calls = [];
  const result = await stopRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['first', 'second', 'third']
  }, {
    coordinator: { acquire: () => true, release: () => calls.push('release') },
    isOwned: (id) => id !== 'second',
    stopProject: async (id) => {
      calls.push(`stop:${id}`);
      return true;
    },
    waitUntilStopped: async (id) => {
      calls.push(`stopped:${id}`);
      return true;
    }
  });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.stoppedProjectIds, ['third', 'first']);
  assert.deepEqual(calls, ['stop:third', 'stopped:third', 'stop:first', 'stopped:first', 'release']);
});

test('reports the blocking project when a group stop cannot be confirmed', async () => {
  const result = await stopRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['first', 'second']
  }, {
    coordinator: { acquire: () => true, release: () => {} },
    isOwned: () => true,
    stopProject: async (id) => id === 'second',
    waitUntilStopped: async (id) => id !== 'second'
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failedProjectId, 'second');
  assert.equal(result.failureReason, 'Runlist could not confirm this project stopped.');
  assert.deepEqual(result.stoppedProjectIds, []);
  assert.deepEqual(result.failedProjectIds, ['second', 'first']);
});

test('stops no further group members after losing the cross-window lease', async () => {
  const calls = [];
  let leaseHeld = true;
  const result = await stopRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['first', 'second']
  }, {
    coordinator: {
      acquire: () => true,
      hasLease: () => leaseHeld,
      release: () => calls.push('release')
    },
    isOwned: () => true,
    stopProject: async (id) => {
      calls.push(`stop:${id}`);
      leaseHeld = false;
      return true;
    },
    waitUntilStopped: async (id) => {
      calls.push(`stopped:${id}`);
      return true;
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureReason, 'Runlist lost cross-window coordination for this group.');
  assert.deepEqual(result.stoppedProjectIds, ['second']);
  assert.deepEqual(calls, ['stop:second', 'stopped:second', 'release']);
});

test('coordinates the same group across independent VS Code hosts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-group-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const readHostProcessIdentity = (pid) => `test-host:${pid}`;
  const firstCoordinator = new RunGroupCoordinator(root, {
    pid: 1101,
    hostIdentity: 'test-host:1101',
    readHostProcessIdentity,
    isProcessAlive: () => true
  });
  const secondCoordinator = new RunGroupCoordinator(root, {
    pid: 2202,
    hostIdentity: 'test-host:2202',
    readHostProcessIdentity,
    isProcessAlive: () => true
  });
  let finishReadiness;
  const readiness = new Promise((resolve) => {
    finishReadiness = resolve;
  });
  const group = { id: 'shared', name: 'Shared', projectIds: ['first'] };
  const options = {
    projects: [{ id: 'first', name: 'First' }],
    getStatus: () => 'stopped',
    startProject: async () => true,
    waitUntilReady: () => readiness,
    stopProject: async () => true,
    waitUntilStopped: async () => true
  };

  const firstRun = startRunGroup(group, { ...options, coordinator: firstCoordinator });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await startRunGroup(group, { ...options, coordinator: secondCoordinator });
  assert.equal(duplicate.status, 'busy');

  finishReadiness(true);
  assert.equal((await firstRun).status, 'started');
});

test('keeps a cross-window group lease alive while readiness is still pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-group-heartbeat-'));
  let now = 1000;
  const sharedOptions = {
    heartbeatIntervalMs: 5,
    ownerHeartbeatTimeoutMs: 20,
    isProcessAlive: () => true,
    readHostProcessIdentity: (pid) => `test-host:${pid}`,
    now: () => now
  };
  const firstCoordinator = new RunGroupCoordinator(root, {
    ...sharedOptions,
    pid: 1101,
    hostIdentity: 'test-host:1101'
  });
  const secondCoordinator = new RunGroupCoordinator(root, {
    ...sharedOptions,
    pid: 2202,
    hostIdentity: 'test-host:2202'
  });
  t.after(() => {
    firstCoordinator.dispose();
    secondCoordinator.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(firstCoordinator.acquire('shared'), true);
  now = 5000;
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(secondCoordinator.acquire('shared'), false);
});

test('marks a rejected or failed group heartbeat as a lost lease without throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-group-lost-lease-'));
  const losses = [];
  const coordinator = new RunGroupCoordinator(root, {
    heartbeatIntervalMs: 60000,
    isProcessAlive: () => true,
    onLeaseLost: (loss) => losses.push(loss),
    pid: 1101,
    hostIdentity: 'test-host:1101',
    readHostProcessIdentity: (pid) => `test-host:${pid}`
  });
  t.after(() => {
    coordinator.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(coordinator.acquire('replaced'), true);
  const setState = coordinator.ownership.setState.bind(coordinator.ownership);
  coordinator.ownership.setState = () => false;
  assert.equal(coordinator.renew('replaced'), false);
  assert.equal(coordinator.hasLease('replaced'), false);
  assert.equal(losses[0].reason, 'ownership-changed');
  coordinator.ownership.setState = setState;
  coordinator.release('replaced');

  assert.equal(coordinator.acquire('failed'), true);
  coordinator.ownership.setState = () => {
    throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
  };
  assert.doesNotThrow(() => coordinator.renew('failed'));
  assert.equal(coordinator.hasLease('failed'), false);
  assert.equal(losses[1].reason, 'heartbeat-failed');
  assert.equal(losses[1].error.code, 'EIO');
  coordinator.ownership.setState = setState;
});

test('creates a group in the exact order selected through native controls', async () => {
  const projects = [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }];
  const actions = ['create', 'add', 'second', 'add', 'first', 'save'];
  let saved;
  const result = await runGroupManagementWorkflow({
    groups: [],
    projects,
    window: {
      showInputBox: async () => 'Daily apps',
      showQuickPick: async (items) => {
        const action = actions.shift();
        return items.find((item) => item.action === action || item.project?.id === action);
      },
      showErrorMessage: async () => {}
    },
    saveGroup: async (group) => {
      saved = group;
    }
  });

  assert.equal(result.status, 'saved');
  assert.deepEqual(saved, {
    name: 'Daily apps',
    projectIds: ['second', 'first'],
    startMode: 'sequential'
  });
});

test('edits member order and renames without changing other group data', async () => {
  const group = { id: 'daily', name: 'Daily apps', projectIds: ['first', 'second'] };
  const saved = [];
  const editActions = ['edit', 'second', 'move-up', 'save'];
  const editResult = await runGroupManagementWorkflow({
    selectedGroupId: group.id,
    groups: [group],
    projects: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
    window: {
      showQuickPick: async (items) => {
        const action = editActions.shift();
        return items.find((item) => item.action === action || item.projectId === action);
      },
      showErrorMessage: async () => {}
    },
    saveGroup: async (value) => saved.push(value)
  });
  assert.equal(editResult.status, 'saved');
  assert.deepEqual(saved[0], {
    ...group,
    projectIds: ['second', 'first'],
    startMode: 'sequential'
  });

  const renameResult = await runGroupManagementWorkflow({
    selectedGroupId: group.id,
    groups: [group],
    projects: [],
    window: {
      showQuickPick: async (items) => items.find((item) => item.action === 'rename'),
      showInputBox: async () => 'Morning apps',
      showErrorMessage: async () => {}
    },
    saveGroup: async (value) => saved.push(value)
  });
  assert.equal(renameResult.status, 'saved');
  assert.deepEqual(saved[1], { ...group, name: 'Morning apps' });
});

test('removes a group only after native modal confirmation', async () => {
  const group = { id: 'daily', name: 'Daily apps', projectIds: ['first'] };
  const removed = [];
  const result = await runGroupManagementWorkflow({
    selectedGroupId: group.id,
    groups: [group],
    projects: [],
    window: {
      showQuickPick: async (items) => items.find((item) => item.action === 'remove'),
      showWarningMessage: async () => 'Remove group',
      showErrorMessage: async () => {}
    },
    removeGroup: async (id) => removed.push(id)
  });

  assert.equal(result.status, 'removed');
  assert.deepEqual(removed, ['daily']);
});
