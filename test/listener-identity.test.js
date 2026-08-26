const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ownedListenerDecision,
  resolvePortListenerIdentity
} = require('../src/ports/listener-identity');

const projects = [
  { id: 'acme', name: 'Acme Storefront' },
  { id: 'api', name: 'Billing API' }
];

function listener(port, pid, identity, name = 'node') {
  return { port, pid, identity, name };
}

test('gone: no OS listener on the port', () => {
  assert.deepEqual(resolvePortListenerIdentity({
    port: 4310,
    listeners: [],
    projects,
    processRuntime: new Map()
  }), { kind: 'gone', port: 4310 });
});

test('owned: matches active Runlist child pid + identity', () => {
  const runtime = new Map([
    ['acme', {
      projectId: 'acme',
      childPid: 120,
      childIdentity: '120:linux:1000',
      processActive: true,
      ownerAvailable: true
    }]
  ]);

  assert.deepEqual(resolvePortListenerIdentity({
    port: 4310,
    listeners: [listener(4310, 120, '120:linux:1000')],
    projects,
    processRuntime: runtime,
    platform: 'linux'
  }), {
    kind: 'owned',
    port: 4310,
    projectId: 'acme',
    projectName: 'Acme Storefront',
    pid: 120,
    name: 'node',
    identity: '120:linux:1000'
  });
});

test('owned: matches detached service listener exact port/pid/identity', () => {
  const runtime = new Map([
    ['api', {
      projectId: 'api',
      detached: true,
      detachedServiceListeners: [
        { port: 7071, pid: 440, identity: '440:linux:55' }
      ]
    }]
  ]);

  assert.deepEqual(resolvePortListenerIdentity({
    port: 7071,
    listeners: [listener(7071, 440, '440:linux:55', 'python')],
    projects,
    processRuntime: runtime,
    platform: 'linux'
  }), {
    kind: 'owned',
    port: 7071,
    projectId: 'api',
    projectName: 'Billing API',
    pid: 440,
    name: 'python',
    identity: '440:linux:55'
  });
});

test('external: listener identity present and no Runlist owner match', () => {
  assert.deepEqual(resolvePortListenerIdentity({
    port: 3000,
    listeners: [listener(3000, 88, '88:linux:9', 'vite')],
    projects,
    processRuntime: new Map([
      ['acme', {
        childPid: 120,
        childIdentity: '120:linux:1000',
        processActive: true
      }]
    ]),
    platform: 'linux'
  }), {
    kind: 'external',
    port: 3000,
    pid: 88,
    name: 'vite',
    identity: '88:linux:9'
  });
});

test('unknown: missing listener identity never becomes external', () => {
  assert.deepEqual(resolvePortListenerIdentity({
    port: 3000,
    listeners: [{ port: 3000, pid: 88, name: 'node' }],
    projects,
    processRuntime: new Map(),
    platform: 'linux'
  }), {
    kind: 'unknown',
    port: 3000,
    reason: 'missing-identity',
    pid: 88,
    name: 'node'
  });
});

test('unknown: same PID as owned child with different identity is pid reuse', () => {
  const runtime = new Map([
    ['acme', {
      childPid: 120,
      childIdentity: '120:linux:1000',
      processActive: true,
      ownerAvailable: true
    }]
  ]);

  assert.deepEqual(resolvePortListenerIdentity({
    port: 4310,
    listeners: [listener(4310, 120, '120:linux:9999')],
    projects,
    processRuntime: runtime,
    platform: 'linux'
  }), {
    kind: 'unknown',
    port: 4310,
    reason: 'pid-reuse',
    pid: 120,
    name: 'node',
    identity: '120:linux:9999'
  });
});

test('unknown: PID matches owned child but identity unavailable', () => {
  assert.equal(ownedListenerDecision(
    listener(4310, 120, '120:runtime:1'),
    {
      childPid: 120,
      childIdentity: '120:linux:1000',
      processActive: true
    },
    'linux'
  ), 'pid-reuse');

  assert.deepEqual(resolvePortListenerIdentity({
    port: 4310,
    listeners: [listener(4310, 120, '120:runtime:1')],
    projects,
    processRuntime: new Map([
      ['acme', {
        childPid: 120,
        childIdentity: '120:linux:1000',
        processActive: true
      }]
    ]),
    platform: 'linux'
  }).kind, 'unknown');
});

test('ambiguous: multiple PIDs listening on the same port', () => {
  const result = resolvePortListenerIdentity({
    port: 4310,
    listeners: [
      listener(4310, 120, '120:linux:1'),
      listener(4310, 121, '121:linux:2')
    ],
    projects,
    processRuntime: new Map(),
    platform: 'linux'
  });
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'multiple-listeners');
  assert.equal(result.listeners.length, 2);
});

test('ambiguous: two Runlist projects both claim the same listener', () => {
  const runtime = new Map([
    ['acme', {
      childPid: 120,
      childIdentity: '120:linux:1000',
      processActive: true
    }],
    ['api', {
      detached: true,
      detachedServiceListeners: [
        { port: 4310, pid: 120, identity: '120:linux:1000' }
      ]
    }]
  ]);

  const result = resolvePortListenerIdentity({
    port: 4310,
    listeners: [listener(4310, 120, '120:linux:1000')],
    projects,
    processRuntime: runtime,
    platform: 'linux'
  });
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'multiple-owners');
  assert.deepEqual(result.projectIds, ['acme', 'api']);
});

test('owned match prefers identity evidence over configured-port assumptions', () => {
  // Another project configures the port, but OS identity proves Acme owns the listener.
  const runtime = new Map([
    ['acme', {
      childPid: 120,
      childIdentity: '120:linux:1000',
      processActive: true
    }]
  ]);
  const result = resolvePortListenerIdentity({
    port: 4310,
    listeners: [listener(4310, 120, '120:linux:1000')],
    projects: [
      ...projects,
      { id: 'other', name: 'Other', services: [{ port: 4310 }] }
    ],
    processRuntime: runtime,
    platform: 'linux'
  });
  assert.equal(result.kind, 'owned');
  assert.equal(result.projectId, 'acme');
});

test('windows and darwin identity strings classify through the shared helper', () => {
  assert.equal(resolvePortListenerIdentity({
    port: 5173,
    listeners: [listener(5173, 501, '501:638123456789012345', 'node.exe')],
    projects,
    processRuntime: new Map([
      ['acme', {
        childPid: 501,
        childIdentity: '501:638123456789012345',
        processActive: true
      }]
    ]),
    platform: 'win32'
  }).kind, 'owned');

  const darwinIdentity = '501:darwin:v2:2024-01-01T00:00:00:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(resolvePortListenerIdentity({
    port: 5173,
    listeners: [listener(5173, 501, darwinIdentity, 'node')],
    projects,
    processRuntime: new Map([
      ['acme', {
        childPid: 501,
        childIdentity: darwinIdentity,
        processActive: true
      }]
    ]),
    platform: 'darwin'
  }).kind, 'owned');
});

test('resolver stays read-only and reuses process identity helpers', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/ports/listener-identity.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /terminateListenerProcess|recoverProjectPorts|process\.kill\(/);
  assert.match(source, /processIdentityDecision/);
  assert.match(source, /stableProcessIdentity/);
});
