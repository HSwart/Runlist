const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  cleanupTrackedProcessForDeletion,
  ownedProcessSpawnOptions,
  terminateOwnedProcessTree,
  terminateTrackedProcess
} = require('../project-process');

test('starts macOS and Linux launchers in their own process group', () => {
  assert.deepEqual(ownedProcessSpawnOptions('darwin'), { detached: true });
  assert.deepEqual(ownedProcessSpawnOptions('linux'), { detached: true });
  assert.deepEqual(ownedProcessSpawnOptions('win32'), {});
});

test('terminates only the tracked POSIX process group', async () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    const otherProcess = { pid: 999, exitCode: null };
    const processes = new Map([
      ['project', { pid: 321, exitCode: null }],
      ['other', otherProcess]
    ]);

    assert.equal(await terminateTrackedProcess(processes, 'project', {
      platform,
      killProcess: (...args) => calls.push(args)
    }), true);
    assert.deepEqual(calls, [[-321, 'SIGTERM']]);
    assert.equal(processes.has('project'), false);
    assert.equal(processes.get('other'), otherProcess);
    assert.equal(await terminateTrackedProcess(processes, 'missing'), false);
  }
});

test('terminates only the tracked Windows process tree with taskkill', async () => {
  const calls = [];
  const fakeTaskkill = new EventEmitter();
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    process.nextTick(() => fakeTaskkill.emit('exit', 0));
    return fakeTaskkill;
  };

  await terminateOwnedProcessTree({ pid: 654, exitCode: null }, {
    platform: 'win32',
    spawnProcess
  });

  assert.deepEqual(calls, [{
    command: 'taskkill',
    args: ['/PID', '654', '/T', '/F'],
    options: { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  }]);
});

test('fails safely when the launched process handle is unavailable or exited', async () => {
  await assert.rejects(
    terminateOwnedProcessTree(undefined, { platform: 'linux' }),
    /valid process handle.*No process was stopped/
  );
  await assert.rejects(
    terminateOwnedProcessTree({ pid: 321, exitCode: 0 }, { platform: 'linux' }),
    /already exited.*No process was stopped/
  );
});

test('uses only an approved post-confirmation snapshot during deletion', async () => {
  const killedGroups = [];
  const stopCalls = [];
  const processes = new Map([
    ['unreviewed', { pid: 101, exitCode: null }],
    ['deleted-elsewhere', { pid: 102, exitCode: null }],
    ['approved', { pid: 103, exitCode: null }]
  ]);
  const approvedProject = { id: 'approved', reviewRequired: false, stopCommand: 'npm stop' };
  const options = {
    platform: 'linux',
    killProcess: (pid, signal) => killedGroups.push([pid, signal])
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
    (project) => stopCalls.push(project),
    options
  );

  assert.deepEqual(killedGroups, [[-101, 'SIGTERM'], [-102, 'SIGTERM']]);
  assert.deepEqual(stopCalls, [approvedProject]);
  assert.equal(processes.has('unreviewed'), false);
  assert.equal(processes.has('deleted-elsewhere'), false);
  assert.equal(processes.has('approved'), true);
});
