const assert = require('node:assert/strict');
const test = require('node:test');
const { ProjectLifecycleCoordinator } = require('../src/lifecycle/project-lifecycle');

test('delegates start and stop mechanics through one lifecycle boundary', async () => {
  const calls = [];
  const host = {
    startProjectProcess: async (id, options) => {
      calls.push(['start', id, options]);
      return true;
    },
    stopProjectProcess: async (id, project, options) => {
      calls.push(['stop', id, project, options]);
      return true;
    }
  };
  const lifecycle = new ProjectLifecycleCoordinator(host);

  assert.equal(await lifecycle.start('project-1', { ownershipReserved: true }), true);
  assert.equal(await lifecycle.stop('project-1', { name: 'Project' }, { allowMissing: true }), true);
  assert.deepEqual(calls, [
    ['start', 'project-1', { ownershipReserved: true }],
    ['stop', 'project-1', { name: 'Project' }, { allowMissing: true }]
  ]);
});

test('blocks new starts and waits for lifecycle work already in flight during shutdown', async () => {
  let finishStop;
  const stop = new Promise((resolve) => { finishStop = resolve; });
  let starts = 0;
  const lifecycle = new ProjectLifecycleCoordinator({
    startProjectProcess: async () => { starts += 1; return true; },
    stopProjectProcess: async () => stop
  });

  const stopping = lifecycle.stop('project-1');
  lifecycle.beginShutdown();
  let shutdownFinished = false;
  const shutdown = lifecycle.waitForIdle().then(() => { shutdownFinished = true; });
  await Promise.resolve();

  assert.equal(shutdownFinished, false);
  assert.equal(await lifecycle.start('project-2'), false);
  assert.equal(starts, 0);

  finishStop(true);
  assert.equal(await stopping, true);
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test('waits for readiness and stop completion using provider state', async () => {
  let readyRefreshes = 0;
  let stopSnapshots = 0;
  const host = {
    getProjectStatus: () => readyRefreshes >= 2 ? 'running' : 'starting',
    refreshProjectStatuses: async () => { readyRefreshes += 1; },
    processOwnership: {
      snapshot: () => new Map(stopSnapshots++ === 0 ? [['project-1', {}]] : [])
    },
    portReservations: { snapshot: () => new Map() },
    remoteStopRequests: new Map([['project-1', {}]]),
    stoppingProjectIds: new Set(['project-1']),
    managedProjectIds: new Set(['project-1']),
    projectStatuses: new Map([['project-1', 'stopping']])
  };
  const lifecycle = new ProjectLifecycleCoordinator(host, {
    delay: async () => {},
    startReadinessTimeoutMs: 100,
    statusPollIntervalMs: 1,
    remoteStopTimeoutMs: 100
  });

  assert.equal(await lifecycle.waitUntilReady('project-1'), true);
  assert.equal(await lifecycle.waitUntilStopped('project-1'), true);
  assert.equal(host.remoteStopRequests.has('project-1'), false);
  assert.equal(host.stoppingProjectIds.has('project-1'), false);
  assert.equal(host.managedProjectIds.has('project-1'), false);
  assert.equal(host.projectStatuses.get('project-1'), 'stopped');
});

test('restarts only after the owned project is confirmed stopped', async () => {
  const calls = [];
  const host = {
    projects: [{ id: 'project-1', services: [], reviewRequired: false }],
    restartingProjectIds: new Set(),
    processOwnership: { snapshot: () => new Map([['project-1', { state: 'running' }]]) },
    portReservations: { snapshot: () => new Map() },
    getProjectStatus: () => 'running',
    stopProject: async () => { calls.push('stop'); return true; },
    waitForProjectStopCompletion: async () => { calls.push('wait'); return true; },
    startProject: async () => { calls.push('start'); return true; }
  };
  const lifecycle = new ProjectLifecycleCoordinator(host);

  assert.equal(await lifecycle.restart('project-1'), true);
  assert.deepEqual(calls, ['stop', 'wait', 'start']);
  assert.equal(host.restartingProjectIds.size, 0);
});

test('allows orphan recovery only when an explicit custom stop is configured', async () => {
  const calls = [];
  const host = {
    projects: [{ id: 'project-1', services: [], stopCommand: 'docker compose down', reviewRequired: false }],
    restartingProjectIds: new Set(),
    processOwnership: { snapshot: () => new Map([['project-1', { state: 'running', ownerAvailable: false }]]) },
    portReservations: { snapshot: () => new Map() },
    getProjectStatus: () => 'ownership-lost',
    stopProject: async () => { calls.push('stop'); return true; },
    waitForProjectStopCompletion: async () => { calls.push('wait'); return true; },
    startProject: async () => { calls.push('start'); return true; }
  };
  const lifecycle = new ProjectLifecycleCoordinator(host);

  assert.equal(await lifecycle.restart('project-1'), true);
  assert.deepEqual(calls, ['stop', 'wait', 'start']);

  host.projects[0].stopCommand = '';
  assert.equal(await lifecycle.restart('project-1'), false);
});

test('waits for every configured service port to close after a custom Stop', async () => {
  let now = 0;
  let checks = 0;
  const lifecycle = new ProjectLifecycleCoordinator({}, {
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    servicePortStatus: async () => ({ anyOpen: checks++ < 2 })
  });
  const project = { services: [{ port: 4310 }] };

  assert.equal(await lifecycle.waitUntilServicesStopped(project, 1000), true);
  assert.equal(checks, 3);
});

test('reports when a successful custom Stop leaves a configured service open', async () => {
  let now = 0;
  const lifecycle = new ProjectLifecycleCoordinator({}, {
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    servicePortStatus: async () => ({ anyOpen: true })
  });

  assert.equal(await lifecycle.waitUntilServicesStopped({
    services: [{ port: 4310 }]
  }, 200), false);
});

test('verifies that a selected temporary service port actually opens', async () => {
  let checks = 0;
  const lifecycle = new ProjectLifecycleCoordinator({}, {
    delay: async () => {},
    now: () => checks * 10,
    servicePortStatus: async () => ({
      allOpen: ++checks >= 3,
      anyOpen: checks >= 3
    })
  });

  assert.equal(await lifecycle.waitUntilServiceReady({ port: 4311 }, 100), true);
  assert.equal(checks, 3);
});

test('rejects a temporary service port that never opens', async () => {
  let now = 0;
  const lifecycle = new ProjectLifecycleCoordinator({}, {
    delay: async () => { now += 100; },
    now: () => now,
    servicePortStatus: async () => ({ allOpen: false, anyOpen: false })
  });

  assert.equal(await lifecycle.waitUntilServiceReady({ port: 4311 }, 200), false);
});

test('requires the full configured readiness check for a temporary service port', async () => {
  let now = 0;
  let checks = 0;
  const service = {
    port: 4311,
    healthCheck: { mode: 'http', method: 'GET', expectedStatus: 204 }
  };
  const lifecycle = new ProjectLifecycleCoordinator({}, {
    delay: async () => { now += 50; },
    isServiceReady: async (candidate) => {
      assert.equal(candidate, service);
      checks += 1;
      return checks >= 3;
    },
    now: () => now,
    servicePortStatus: async () => ({ allOpen: true, anyOpen: true })
  });

  assert.equal(await lifecycle.waitUntilServiceReady(service, 200), true);
  assert.equal(checks, 3);
});

test('cancels temporary service verification when its exact launch changes', async () => {
  let current = true;
  let checks = 0;
  const lifecycle = new ProjectLifecycleCoordinator({}, {
    isServiceReady: async () => {
      checks += 1;
      current = false;
      return true;
    },
    servicePortStatus: async () => ({ allOpen: true, anyOpen: true })
  });

  assert.equal(await lifecycle.waitUntilServiceReady(
    { port: 4311 },
    100,
    () => current
  ), false);
  assert.equal(checks, 1);
});
