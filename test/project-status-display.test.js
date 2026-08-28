const assert = require('node:assert/strict');
const test = require('node:test');
const {
  projectDisplayedStatus,
  projectPrimaryStatusCode,
  projectShowsMissingFolder,
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

  assert.equal(projectPrimaryStatusCode({ status: 'not-responding' }), 'not-responding');
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'not-responding' }), 'Web service not responding');
  assert.notEqual(projectDisplayedStatus({ name: 'App', status: 'not-responding' }), 'Running');
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'not-responding' }),
    'App: Web service not responding'
  );

  assert.equal(projectDisplayedStatus({ name: 'App', status: 'active' }), 'Running elsewhere');
  assert.notEqual(projectDisplayedStatus({ name: 'App', status: 'active' }), 'Running');
  assert.equal(projectStatusDetailText({ name: 'App', status: 'active' }), '');
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'active' }),
    'App is running elsewhere. Add a stop command to control it from Runlist.'
  );
  assert.equal(
    projectDisplayedStatus({ name: 'App', status: 'active', stopCommand: 'docker compose down' }),
    'Detected'
  );
  assert.equal(
    projectStatusAnnouncement({ name: 'App', status: 'active', stopCommand: 'docker compose down' }),
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

test('shows a short start-fail label on line 2 with detail kept for announcements', () => {
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      failureSummary: { title: 'Start failed', message: '/bin/sh: vite: command not found' }
    }),
    'Start failed'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      failureSummary: { title: 'Start failed' }
    }),
    'Start failed'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'stopped',
      failureSummary: { message: '/bin/sh: vite: command not found' }
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

test('missing-required-env keeps Start failed on line 2 and announces setup help', () => {
  const project = {
    name: 'API',
    status: 'stopped',
    failureSummary: {
      title: 'Start failed',
      message: 'Missing required environment variables for this launch profile: API_KEY, DATABASE_URL.',
      kind: 'missing-required-env'
    }
  };
  assert.equal(projectDisplayedStatus(project), 'Start failed');
  assert.equal(
    projectStatusAnnouncement(project),
    'API needs environment variables before it can start.'
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

test('shows Folder missing on stopped rows without waiting for Start', () => {
  assert.equal(projectShowsMissingFolder({
    name: 'App',
    status: 'stopped',
    folderAccessible: false
  }), true);
  assert.equal(projectDisplayedStatus({
    name: 'App',
    status: 'stopped',
    folderAccessible: false
  }), 'Folder missing');
  assert.equal(projectDisplayedStatus({
    name: 'App',
    status: 'stopped',
    folderAccessible: false,
    failureSummary: { title: 'Start failed', message: 'ENOENT' }
  }), 'Folder missing');
  assert.equal(projectShowsMissingFolder({
    name: 'App',
    status: 'running',
    folderAccessible: false
  }), false);
  assert.equal(projectDisplayedStatus({
    name: 'App',
    status: 'running',
    folderAccessible: false
  }), 'Running');
  assert.equal(projectDisplayedStatus({
    name: 'App',
    status: 'stopped',
    folderAccessible: false,
    reviewRequired: true
  }), 'Review setup');
});

test('not-ready and not-responding rows name the first blocking service on line 2', () => {
  const readiness = {
    ready: [{ name: 'Web', port: 3000 }],
    waiting: [{ name: 'API', port: 3001 }],
    notResponding: []
  };
  assert.equal(
    projectDisplayedStatus({ name: 'App', status: 'not-ready', serviceReadiness: readiness }),
    'Taking longer — API :3001'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-ready',
      serviceReadiness: {
        ready: [],
        waiting: [],
        notResponding: [{ name: 'Web', port: 5173 }]
      }
    }),
    'Taking longer — Web :5173'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-ready',
      serviceReadiness: {
        ready: [],
        waiting: [
          { name: 'API', port: 3001 },
          { name: 'Worker', port: 3002 },
          { name: 'Cache', port: 3003 }
        ],
        notResponding: []
      }
    }),
    'Taking longer — API :3001 +2 more'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-responding',
      serviceReadiness: {
        ready: [{ name: 'API', port: 3001 }],
        waiting: [],
        notResponding: [{ name: 'Web', port: 5173 }]
      }
    }),
    'Web service not responding — Web :5173'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-responding',
      serviceReadiness: {
        ready: [],
        waiting: [{ name: 'API', port: 3001 }],
        notResponding: [{ name: 'Web', port: 5173 }, { name: 'Admin', port: 5174 }]
      }
    }),
    'Web service not responding — API :3001 +2 more'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'active',
      httpUnresponsive: true,
      serviceReadiness: {
        ready: [],
        waiting: [],
        notResponding: [{ name: 'Web', port: 5173 }]
      }
    }),
    'Web service not responding — Web :5173'
  );
  assert.equal(projectDisplayedStatus({ name: 'App', status: 'not-ready' }), 'Starting…');
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-ready',
      serviceReadiness: { ready: [{ name: 'Web', port: 3000 }], waiting: [], notResponding: [] }
    }),
    'Starting…'
  );
  assert.equal(
    projectDisplayedStatus({ name: 'App', status: 'not-responding' }),
    'Web service not responding'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-ready',
      forceClosing: true,
      serviceReadiness: readiness
    }),
    'Closing processes…'
  );
  assert.equal(
    projectDisplayedStatus({
      name: 'App',
      status: 'not-ready',
      reviewRequired: true,
      serviceReadiness: readiness
    }),
    'Review setup'
  );
  assert.equal(
    projectDisplayedStatus({ name: 'App', status: 'running', serviceReadiness: readiness }),
    'Running'
  );
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
});
