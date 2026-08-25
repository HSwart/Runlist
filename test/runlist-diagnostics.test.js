const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_EVENTS,
  RunlistDiagnostics,
  redactDiagnosticDetail
} = require('../src/lifecycle/runlist-diagnostics');

function createDiagnostics(options = {}) {
  let tick = 0;
  return new RunlistDiagnostics({
    now: () => Date.UTC(2026, 7, 23, 12, 0, tick++),
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    projectSalt: 'test-session-salt',
    environment: {
      runlistVersion: '0.0.8',
      vscodeVersion: '1.105.0',
      platform: 'darwin',
      arch: 'arm64',
      remoteKind: 'local'
    },
    ...options
  });
}

test('support diagnostics expose only allowlisted, redacted local state', () => {
  const lines = [];
  const diagnostics = createDiagnostics({
    outputChannel: { appendLine: (line) => lines.push(line) },
    traceEnabled: () => true
  });
  const projectId = 'private-project-id';
  const projectRef = diagnostics.projectRef(projectId);

  diagnostics.record('start.failed', {
    projectId,
    status: 'stopped',
    error: {
      code: 'EACCES',
      message: 'TOKEN=secret-value failed in /Users/alice/Private Project/app.js'
    },
    command: 'npm run private-command',
    port: 4321,
    output: 'raw process output'
  });

  const report = diagnostics.supportReport({
    projectCount: 1,
    ownershipCount: 0,
    reservationCount: 0,
    localProcessCount: 0,
    projects: [{
      id: projectId,
      name: 'Secret Project Name',
      folder: '/Users/alice/Private Project',
      startCommand: 'npm run private-command',
      env: { TOKEN: 'secret-value' },
      services: [{ port: 4321 }],
      output: 'raw process output',
      status: 'stopped',
      serviceCount: 1,
      ownershipPresent: false,
      reservationPresent: false,
      localProcess: false
    }]
  });
  const parsed = JSON.parse(report);

  assert.equal(parsed.projects[0].projectRef, projectRef);
  assert.equal(parsed.projects[0].status, 'stopped');
  assert.equal(parsed.projects[0].serviceCount, 1);
  assert.equal(parsed.recentEvents.at(-1).errorCode, 'EACCES');
  assert.match(parsed.recentEvents.at(-1).detail, /TOKEN=\[redacted\]/);
  assert.match(parsed.recentEvents.at(-1).detail, /\[path\]/);
  for (const sensitiveValue of [
    projectId,
    'Secret Project Name',
    '/Users/alice',
    'Private Project',
    'npm run private-command',
    'secret-value',
    '4321',
    'raw process output'
  ]) {
    assert.equal(report.includes(sensitiveValue), false, sensitiveValue);
    assert.equal(lines.join('\n').includes(sensitiveValue), false, sensitiveValue);
  }
});

test('trace details are omitted unless the local trace setting is enabled', () => {
  const diagnostics = createDiagnostics({ traceEnabled: () => false });

  diagnostics.record('stop.failed', {
    error: { code: 'EPERM', message: 'TOKEN=secret-value' }
  });

  const event = JSON.parse(diagnostics.supportReport()).recentEvents.at(-1);
  assert.equal(event.errorCode, 'EPERM');
  assert.equal(Object.hasOwn(event, 'detail'), false);
});

test('nested lifecycle operations share one correlation identifier', async () => {
  const diagnostics = createDiagnostics();

  await diagnostics.run('restart', 'project-1', async () => {
    await diagnostics.run('stop', 'project-1', async () => true);
    return true;
  });

  const events = JSON.parse(diagnostics.supportReport()).recentEvents
    .filter((event) => event.event !== 'session.started');
  assert.deepEqual(events.map((event) => event.event), [
    'restart.begin',
    'stop.begin',
    'stop.complete',
    'restart.complete'
  ]);
  assert.equal(new Set(events.map((event) => event.operationId)).size, 1);
});

test('lifecycle completion records the previous state, resulting state, and reason', async () => {
  const diagnostics = createDiagnostics();
  let status = 'stopped';

  await diagnostics.run('start', 'project-1', async () => {
    status = 'running';
    return true;
  }, () => ({ status }));

  const events = JSON.parse(diagnostics.supportReport()).recentEvents
    .filter((event) => event.event.startsWith('start.'));
  assert.deepEqual(events, [
    {
      at: '2026-08-23T12:00:01.000Z',
      event: 'start.begin',
      operationId: '11111111-1111-4111-8111-111111111111',
      projectRef: diagnostics.projectRef('project-1'),
      status: 'stopped'
    },
    {
      at: '2026-08-23T12:00:02.000Z',
      event: 'start.complete',
      operationId: '11111111-1111-4111-8111-111111111111',
      projectRef: diagnostics.projectRef('project-1'),
      outcome: 'completed',
      status: 'running',
      previousStatus: 'stopped',
      resultingStatus: 'running',
      reasonCode: 'operation-completed'
    }
  ]);
});

test('rejected lifecycle completion keeps its exact transition reason', async () => {
  const diagnostics = createDiagnostics();

  await diagnostics.run('stop', 'project-1', async () => false, () => ({
    status: 'ownership-lost'
  }));

  const event = JSON.parse(diagnostics.supportReport()).recentEvents.at(-1);
  assert.equal(event.previousStatus, 'ownership-lost');
  assert.equal(event.resultingStatus, 'ownership-lost');
  assert.equal(event.reasonCode, 'operation-rejected');
});

test('records lifecycle work that exceeds the event-loop delay budget', async () => {
  const monotonicTimes = [0, 175];
  const diagnostics = createDiagnostics({
    monotonicNow: () => monotonicTimes.shift(),
    scheduleImmediate: (callback) => callback()
  });

  await diagnostics.run('start', 'project-1', async () => true);

  const events = JSON.parse(diagnostics.supportReport()).recentEvents;
  const delay = events.find((event) => event.event === 'start.event-loop-delay');
  assert.equal(delay.eventLoopDelayMs, 175);
  assert.equal(delay.reasonCode, 'budget-exceeded');
});

test('diagnostic history remains bounded in memory', () => {
  const diagnostics = createDiagnostics();

  for (let index = 0; index < MAX_EVENTS + 50; index += 1) {
    diagnostics.record('status.sample', { serviceCount: index });
  }

  const events = JSON.parse(diagnostics.supportReport()).recentEvents;
  assert.equal(events.length, MAX_EVENTS);
  assert.equal(events[0].event, 'status.sample');
  assert.equal(events.at(-1).serviceCount, MAX_EVENTS + 49);
});

test('diagnostic details redact credentials, URLs, and local paths', () => {
  const detail = redactDiagnosticDetail(
    'Bearer abc.def TOKEN=value https://example.test/path?token=value /home/alice/private/file.js'
  );

  assert.equal(detail.includes('abc.def'), false);
  assert.equal(detail.includes('TOKEN=value'), false);
  assert.equal(detail.includes('token=value'), false);
  assert.equal(detail.includes('/home/alice'), false);
  assert.match(detail, /Bearer \[redacted\]/);
});
