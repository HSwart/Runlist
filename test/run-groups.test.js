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
} = require('../project-store');
const {
  RunGroupCoordinator,
  runGroupManagementWorkflow,
  startRunGroup,
  stopRunGroup
} = require('../run-groups');

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
    projectIds: [second.id, first.id]
  }]);

  upsertRunGroup(projectsFile, {
    id: created.group.id,
    name: 'Morning apps',
    projectIds: [first.id]
  });
  assert.deepEqual(readRunGroups(projectsFile)[0], {
    id: created.group.id,
    name: 'Morning apps',
    projectIds: [first.id]
  });

  assert.equal(removeRunGroup(projectsFile, created.group.id), true);
  assert.deepEqual(readRunGroups(projectsFile), []);
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

test('coordinates the same group across independent VS Code hosts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-group-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstCoordinator = new RunGroupCoordinator(root, { pid: 1101, isProcessAlive: () => true });
  const secondCoordinator = new RunGroupCoordinator(root, { pid: 2202, isProcessAlive: () => true });
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
    now: () => now
  };
  const firstCoordinator = new RunGroupCoordinator(root, { ...sharedOptions, pid: 1101 });
  const secondCoordinator = new RunGroupCoordinator(root, { ...sharedOptions, pid: 2202 });
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
  assert.deepEqual(saved, { name: 'Daily apps', projectIds: ['second', 'first'] });
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
  assert.deepEqual(saved[0], { ...group, projectIds: ['second', 'first'] });

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
