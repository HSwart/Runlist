const assert = require('node:assert/strict');
const test = require('node:test');
const {
  managedPortBlockers,
  portClosureConfirmation,
  recoverProjectPorts,
  relatedPortProjectIds
} = require('../src/ports/port-recovery');

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

test('identifies only live available Runlist owners as close-and-start blockers', () => {
  const runtime = new Map([
    ['live', { ownerAvailable: true, processActive: true, state: 'running' }],
    ['stopping', { ownerAvailable: true, processActive: true, state: 'stopping' }],
    ['orphan', { ownerAvailable: false, processActive: true, state: 'running' }],
    ['exited', { ownerAvailable: true, processActive: false, state: 'running' }]
  ]);

  assert.deepEqual(managedPortBlockers(
    ['live', 'live', 'stopping', 'orphan', 'exited'],
    runtime,
    [
      { id: 'live', name: 'Live project' },
      { id: 'stopping', name: 'Stopping project' }
    ]
  ), [
    { id: 'live', name: 'Live project' },
    { id: 'stopping', name: 'Stopping project' }
  ]);
});

test('finds related projects even when their port reservation is missing', () => {
  assert.deepEqual([...relatedPortProjectIds(
    { id: 'target', services: [{ port: 4280 }, { port: 7071 }] },
    [{ port: 4280, projectId: 'reserved' }],
    [
      { id: 'target', services: [{ port: 4280 }] },
      { id: 'reserved', services: [{ port: 9000 }] },
      { id: 'missing-lock', services: [{ port: '7071' }] },
      { id: 'unrelated', services: [{ port: 3000 }] }
    ]
  )], ['reserved', 'missing-lock']);
});

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
      {
        pid: 80,
        identity: '80:first',
        name: 'Saved Runlist process',
        ports: [],
        terminateTree: true
      }
    ],
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => [listener(4280, 120, '120:first')],
    confirmPortClosure: async ({ processes }) => {
      assert.deepEqual(processes, [
        { pid: 120, identity: '120:first', name: 'node', ports: [4280] },
        {
          pid: 80,
          identity: '80:first',
          name: 'Saved Runlist process',
          ports: [],
          terminateTree: true
        }
      ]);
      return true;
    },
    terminateListenerProcess: async (process, options) => terminated.push({ process, options }),
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(terminated.map(({ process, options }) => ({
    pid: process.pid,
    allowMissing: options.allowMissing,
    terminateTree: options.terminateTree
  })), [
    { pid: 120, allowMissing: false, terminateTree: undefined },
    { pid: 80, allowMissing: true, terminateTree: true }
  ]);
  assert.deepEqual(result, { status: 'closed', openPorts: [4280], processCount: 2 });
});

test('stops the verified Runlist process tree even when no configured ports are open', async () => {
  const terminated = [];
  const serviceChecks = [];
  const result = await recoverProjectPorts({ ...project, services: [] }, 'stop', {
    additionalProcesses: [
      {
        pid: 80,
        identity: '80:first',
        name: 'Saved Runlist process',
        ports: [],
        terminateTree: true
      }
    ],
    getOpenPorts: async (services) => {
      serviceChecks.push(services);
      return [];
    },
    findListeningProcesses: async () => {
      throw new Error('there are no ports to inspect');
    },
    confirmPortClosure: async ({ openPorts, processes }) => {
      assert.deepEqual(openPorts, []);
      assert.deepEqual(processes, [{
        pid: 80,
        identity: '80:first',
        name: 'Saved Runlist process',
        ports: [],
        terminateTree: true
      }]);
      return true;
    },
    terminateListenerProcess: async (process, options) => terminated.push({ process, options }),
    waitForPortsClosed: async (services) => {
      assert.deepEqual(services, []);
      return true;
    }
  });

  assert.equal(serviceChecks.length, 2);
  assert.deepEqual(terminated, [{
    process: {
      pid: 80,
      identity: '80:first',
      name: 'Saved Runlist process',
      ports: [],
      terminateTree: true
    },
    options: { allowMissing: true, terminateTree: true }
  }]);
  assert.deepEqual(result, { status: 'closed', openPorts: [], processCount: 1 });
});

test('does not terminate a saved process during Start after its conflicting ports close', async () => {
  const result = await recoverProjectPorts(project, 'start', {
    additionalProcesses: [
      {
        pid: 80,
        identity: '80:first',
        name: 'Saved Runlist process',
        ports: [],
        terminateTree: true
      }
    ],
    getOpenPorts: async () => [],
    findListeningProcesses: async () => {
      throw new Error('there are no ports to inspect');
    },
    confirmPortClosure: async () => {
      throw new Error('confirmation must not be shown');
    },
    terminateListenerProcess: async () => {
      throw new Error('process must not be terminated');
    },
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(result, { status: 'closed', openPorts: [], processCount: 0 });
});

test('merges a Runlist root that also owns a port and terminates its tree once', async () => {
  const terminated = [];
  const result = await recoverProjectPorts(project, 'stop', {
    additionalProcesses: [
      {
        pid: 120,
        identity: '120:first',
        name: 'Saved Runlist process',
        ports: [],
        terminateTree: true
      }
    ],
    getOpenPorts: async () => [4280],
    findListeningProcesses: async () => [listener(4280, 120, '120:first')],
    confirmPortClosure: async ({ processes }) => {
      assert.deepEqual(processes, [{
        pid: 120,
        identity: '120:first',
        name: 'node',
        ports: [4280],
        terminateTree: true
      }]);
      return true;
    },
    terminateListenerProcess: async (process, options) => terminated.push({ process, options }),
    waitForPortsClosed: async () => true
  });

  assert.equal(terminated.length, 1);
  assert.equal(terminated[0].process.pid, 120);
  assert.equal(terminated[0].options.terminateTree, true);
  assert.deepEqual(result, { status: 'closed', openPorts: [4280], processCount: 1 });
});

test('terminates listener descendants before a Runlist root that also owns a port', async () => {
  const terminated = [];
  const result = await recoverProjectPorts(project, 'stop', {
    additionalProcesses: [
      {
        pid: 80,
        identity: '80:first',
        name: 'Saved Runlist process',
        ports: [],
        terminateTree: true
      }
    ],
    getOpenPorts: async () => [4280, 7071],
    findListeningProcesses: async () => [
      listener(4280, 80, '80:first'),
      listener(7071, 120, '120:first')
    ],
    confirmPortClosure: async () => true,
    terminateListenerProcess: async (process, options) => terminated.push({ process, options }),
    waitForPortsClosed: async () => true
  });

  assert.deepEqual(terminated.map(({ process, options }) => ({
    pid: process.pid,
    terminateTree: options.terminateTree
  })), [
    { pid: 120, terminateTree: undefined },
    { pid: 80, terminateTree: true }
  ]);
  assert.deepEqual(result, { status: 'closed', openPorts: [4280, 7071], processCount: 2 });
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
