const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildProjectListenerOwners,
  presentRowListenerOwner,
  rowListenerOwnerVisible,
  rowListenerProbePort
} = require('../src/ports/row-listener-owner');

const projects = [
  {
    id: 'acme',
    name: 'Acme Storefront',
    services: [{ name: 'web', port: 4310 }]
  },
  {
    id: 'api',
    name: 'Billing API',
    services: [{ name: 'api', port: 7071 }]
  }
];

test('presents this-app, other Runlist, and external owner classes', () => {
  assert.deepEqual(presentRowListenerOwner({
    status: 'running',
    projectId: 'acme',
    identity: {
      kind: 'owned',
      port: 4310,
      projectId: 'acme',
      projectName: 'Acme Storefront'
    }
  }), {
    kind: 'this-app',
    label: '',
    announcement: 'Port owned by this app',
    title: 'This app owns the listener on its configured port.',
    revealProjectId: undefined
  });

  const other = presentRowListenerOwner({
    status: 'port-in-use',
    projectId: 'acme',
    identity: {
      kind: 'owned',
      port: 4310,
      projectId: 'api',
      projectName: 'Billing API'
    }
  });
  assert.equal(other.kind, 'other-runlist');
  assert.equal(other.label, 'Billing API');
  assert.match(other.announcement, /another Runlist app/i);
  assert.equal(other.revealProjectId, 'api');

  const external = presentRowListenerOwner({
    status: 'port-in-use-unknown',
    projectId: 'acme',
    identity: {
      kind: 'external',
      port: 4310,
      pid: 88,
      name: 'python'
    }
  });
  assert.equal(external.kind, 'external');
  assert.equal(external.label, 'python · PID 88');
  assert.match(external.announcement, /external process/i);
  assert.equal(external.revealProjectId, undefined);
});

test('skips owner presentation when status is stopped or listener is gone', () => {
  assert.equal(presentRowListenerOwner({
    status: 'stopped',
    projectId: 'acme',
    identity: { kind: 'external', port: 4310, pid: 1, name: 'node' }
  }), undefined);
  assert.equal(presentRowListenerOwner({
    status: 'running',
    projectId: 'acme',
    identity: { kind: 'gone', port: 4310 }
  }), undefined);
});

test('hides duplicate other-runlist label when status capsule already names the owner', () => {
  const owner = presentRowListenerOwner({
    status: 'port-in-use',
    projectId: 'acme',
    identity: {
      kind: 'owned',
      port: 4310,
      projectId: 'api',
      projectName: 'Billing API'
    }
  });
  assert.equal(rowListenerOwnerVisible(owner, { ownerName: 'Billing API' }), false);
  assert.equal(rowListenerOwnerVisible(owner, { ownerName: 'Other' }), true);
  assert.equal(rowListenerOwnerVisible({
    kind: 'external',
    label: 'python · PID 88'
  }, undefined), true);
});

test('builds per-project listener owners from one listener scan', () => {
  const owners = buildProjectListenerOwners({
    projects,
    statuses: new Map([
      ['acme', 'running'],
      ['api', 'port-in-use-unknown']
    ]),
    openPorts: new Map([
      ['acme', [4310]],
      ['api', [7071]]
    ]),
    conflicts: new Map([
      ['api', { kind: 'occupied', port: 7071 }]
    ]),
    listeners: [
      { port: 4310, pid: 120, identity: '120:linux:1000', name: 'node' },
      { port: 7071, pid: 88, identity: '88:linux:9', name: 'python' }
    ],
    processRuntime: new Map([
      ['acme', {
        childPid: 120,
        childIdentity: '120:linux:1000',
        processActive: true
      }]
    ]),
    platform: 'linux'
  });

  assert.equal(owners.get('acme').kind, 'this-app');
  assert.equal(owners.get('api').kind, 'external');
  assert.equal(owners.get('api').label, 'python · PID 88');
  assert.equal(rowListenerProbePort({
    portConflict: { port: 7071 },
    openPorts: [4310],
    services: [{ port: 3000 }]
  }), 7071);
});
