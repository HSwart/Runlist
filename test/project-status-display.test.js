const assert = require('node:assert/strict');
const test = require('node:test');
const {
  projectDisplayedStatus,
  projectPrimaryStatusCode,
  projectStatusAnnouncement,
  projectStatusDetailText
} = require('../media/project-status-display');

test('keeps Running, Starting, and Stopped as the status capsule on the happy path', () => {
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'stopped' }), 'Stopped');
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'starting' }), 'Starting…');
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'running' }), 'Running');
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'stopping' }), 'Stopping…');
  assert.equal(projectDisplayedStatus({ name: 'App', reviewRequired: true, status: 'stopped' }), 'Review setup');
  assert.match(
    projectDisplayedStatus({
      name: 'App',
      status: 'port-in-use',
      services: [{ name: 'Web', port: 3000 }],
      openPorts: [3000],
      portConflict: { ownerName: 'API' }
    }),
    /blocked by API/
  );
});

test('moves uncommon lifecycle phrases off the capsule without renaming them as Running', () => {
  assert.equal(projectPrimaryStatusCode({ status: 'not-ready' }), 'starting');
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'not-ready' }), 'Starting…');
  assert.match(projectStatusDetailText({
    name: 'App',
    status: 'not-ready',
    serviceReadiness: {
      ready: [{ name: 'Web', port: 3000 }],
      waiting: [{ name: 'API', port: 4000 }],
      notResponding: []
    }
  }), /Taking longer…/);
  assert.equal(
    projectStatusAnnouncement({
      name: 'App',
      status: 'not-ready',
      serviceReadiness: {
        ready: [{ name: 'Web', port: 3000 }],
        waiting: [{ name: 'API', port: 4000 }],
        notResponding: []
      }
    }),
    'App: Taking longer… Ready: Web :3000. Still checking: API :4000'
  );

  assert.equal(projectPrimaryStatusCode({ status: 'not-responding' }), 'running');
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'not-responding' }), 'Running');
  assert.equal(projectStatusDetailText({ name: 'App', status: 'not-responding' }), 'Web service not responding');
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'not-responding' }),
    'App: Web service not responding'
  );

  assert.equal(projectDisplayedStatus({ name: 'App', status: 'active' }), 'Detected');
  assert.notEqual(projectDisplayedStatus({ name: 'App', status: 'active' }), 'Running');
  assert.equal(projectStatusDetailText({ name: 'App', status: 'active' }), '');
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'active' }),
    'App: Detected'
  );

  assert.equal(projectDisplayedStatus({ name: 'App', status: 'ownership-lost' }), 'Unavailable');
  assert.match(projectStatusDetailText({ name: 'App', status: 'ownership-lost' }), /control unavailable/);
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'ownership-lost' }),
    'App: Running — control unavailable'
  );

  assert.equal(projectDisplayedStatus({ name: 'App', status: 'unsupported' }), 'Local only');
  assert.equal(projectStatusDetailText({ name: 'App', status: 'unsupported' }), 'Local lifecycle only');
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'unsupported' }),
    'App: Local lifecycle only'
  );

  assert.equal(
    projectStatusAnnouncement({
      name: 'App',
      status: 'running',
      listenerOwner: {
        kind: 'this-app',
        announcement: 'Port owned by this app'
      }
    }),
    'App: Running Port owned by this app'
  );
  assert.match(
    projectStatusAnnouncement({
      name: 'App',
      status: 'port-in-use-unknown',
      services: [{ name: 'Web', port: 3000 }],
      openPorts: [3000],
      listenerOwner: {
        kind: 'external',
        announcement: 'Port owned by external process python · PID 88'
      }
    }),
    /external process python · PID 88/
  );
});

test('shows the start fail reason on line 2 instead of Stopped', () => {
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      failureSummary: { title: 'Start failed', message: '/bin/sh: vite: command not found' }
    }),
    '/bin/sh: vite: command not found'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      failureSummary: { title: 'Start failed' }
    }),
    'Start failed'
  );
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'stopped' }), 'Stopped');
  assert.notEqual(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      failureSummary: { title: 'Start failed' }
    }),
    'Stopped'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'running',
      failureSummary: { title: 'Start failed', message: 'stale' }
    }),
    'Running'
  );
  assert.equal(
    projectStatusAnnouncement({
      name: 'App',
      status: 'stopped',
      failureSummary: { message: 'Process exited with code 1.' }
    }),
    'App: Process exited with code 1.'
  );
});

test('shows Stop honesty on line 2 instead of Stopped', () => {
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'running',
      stopFailure: 'Stop failed'
    }),
    'Stop failed'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'active',
      openPorts: [3000],
      stopFailure: 'Port :3000 is still up'
    }),
    'Port :3000 is still up'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      stopFailure: 'Stop failed'
    }),
    'Stopped'
  );
  assert.equal(
    projectStatusAnnouncement({
      name: 'App',
      status: 'running',
      stopFailure: 'Stop failed'
    }),
    'App: Stop failed'
  );
});
