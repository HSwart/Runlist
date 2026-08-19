const assert = require('node:assert/strict');
const test = require('node:test');
const { portClosureConfirmation, recoverProjectPorts } = require('../port-recovery');

const project = {
  id: 'attributes',
  name: 'AppSuite Attributes Finder',
  services: [
    { name: 'web', port: 4280 },
    { name: 'api', port: 7071 }
  ]
};

function listener(port, pid, identity, name = 'node') {
  return { port, pid, identity, name };
}

test('cancelling the native confirmation leaves every listener untouched', async () => {
  const terminated = [];
  const result = await recoverProjectPorts(project, 'stop', {
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => [listener(4280, 120, '120:first')],
    confirmPortClosure: async ({ intent, openPorts, processes }) => {
      assert.equal(intent, 'stop');
      assert.deepEqual(openPorts, [4280]);
      assert.deepEqual(processes, [{ pid: 120, identity: '120:first', name: 'node', ports: [4280] }]);
      return false;
    },
    terminateListenerProcess: async (process) => terminated.push(process),
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(result, { status: 'canceled' });
  assert.deepEqual(terminated, []);
});

test('revalidates identities and terminates one exact process only once across several ports', async () => {
  let inspection = 0;
  const terminated = [];
  const result = await recoverProjectPorts(project, 'start', {
    getOpenPorts: async () => [4280, 7071],
    findListeningProcesses: async () => {
      inspection += 1;
      return [
        listener(4280, 120, '120:first'),
        listener(7071, 120, '120:first')
      ];
    },
    confirmPortClosure: async () => true,
    terminateListenerProcess: async (process) => terminated.push(process),
    waitForPortsClosed: async (services) => {
      assert.equal(services, project.services);
      return true;
    }
  });

  assert.equal(inspection, 2);
  assert.deepEqual(terminated, [
    { pid: 120, identity: '120:first', name: 'node', ports: [4280, 7071] }
  ]);
  assert.deepEqual(result, { status: 'closed', openPorts: [4280, 7071], processCount: 1 });
});

test('also closes the exact saved Runlist project process after ownership was lost', async () => {
  const terminated = [];
  const result = await recoverProjectPorts(project, 'stop', {
    additionalProcesses: [
      { pid: 80, identity: '80:first', name: 'Saved Runlist process', ports: [] }
    ],
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => [listener(4280, 120, '120:first')],
    confirmPortClosure: async ({ processes }) => {
      assert.deepEqual(processes, [
        { pid: 120, identity: '120:first', name: 'node', ports: [4280] },
        { pid: 80, identity: '80:first', name: 'Saved Runlist process', ports: [] }
      ]);
      return true;
    },
    terminateListenerProcess: async (process, options) => terminated.push({ process, options }),
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(terminated.map(({ process, options }) => ({
    pid: process.pid,
    allowMissing: options.allowMissing
  })), [
    { pid: 120, allowMissing: false },
    { pid: 80, allowMissing: true }
  ]);
  assert.deepEqual(result, { status: 'closed', openPorts: [4280], processCount: 2 });
});

test('aborts without terminating when a listener identity changes during confirmation', async () => {
  let inspection = 0;
  const terminated = [];
  const result = await recoverProjectPorts(project, 'stop', {
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => {
      inspection += 1;
      return inspection === 1
        ? [listener(4280, 120, '120:first')]
        : [listener(4280, 120, '120:replacement')];
    },
    confirmPortClosure: async () => true,
    terminateListenerProcess: async (process) => terminated.push(process),
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(result, { status: 'changed' });
  assert.deepEqual(terminated, []);
});

test('refuses an open port when its exact listener or process identity cannot be resolved', async () => {
  const result = await recoverProjectPorts(project, 'stop', {
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => [{ port: 4280, pid: 120, name: 'node' }],
    confirmPortClosure: async () => {
      throw new Error('confirmation must not be shown');
    },
    terminateListenerProcess: async () => {
      throw new Error('listener must not be terminated');
    },
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(result, { status: 'unresolved', ports: [4280] });
});

test('never offers to terminate the current extension host', async () => {
  const result = await recoverProjectPorts(project, 'stop', {
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => [listener(4280, 999, '999:first')],
    protectedPids: new Set([999]),
    confirmPortClosure: async () => {
      throw new Error('confirmation must not be shown');
    },
    terminateListenerProcess: async () => {
      throw new Error('listener must not be terminated');
    },
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(result, { status: 'protected', processes: ['node (PID 999)'] });
});

test('builds a plain-language native confirmation with services, ports, and exact PIDs', () => {
  assert.deepEqual(portClosureConfirmation(project, 'start', [4280, 7071], [
    { pid: 120, identity: '120:first', name: 'node', ports: [4280] },
    { pid: 240, identity: '240:first', name: 'func', ports: [7071] }
  ]), {
    message: 'Close the processes blocking AppSuite Attributes Finder?',
    confirmLabel: 'Close processes and start',
    detail: [
      'web :4280 — node (PID 120)',
      'api :7071 — func (PID 240)',
      '',
      'These processes may belong to another app. Unsaved work in them could be lost.'
    ].join('\n')
  });
});

test('identifies a saved Runlist root process separately from current port listeners', () => {
  const confirmation = portClosureConfirmation(project, 'stop', [4280], [
    { pid: 80, identity: '80:first', name: 'Saved Runlist process', ports: [] },
    { pid: 120, identity: '120:first', name: 'node', ports: [4280] }
  ]);

  assert.match(confirmation.detail, /^web :4280 — node \(PID 120\)\nProject process — Saved Runlist process \(PID 80\)/);
});
