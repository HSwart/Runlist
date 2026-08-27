const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  WEBVIEW_COMMAND_TYPES,
  WEBVIEW_MESSAGE_TYPES,
  createWebviewCommandRouter,
  createWebviewMessageRouter,
  validateWebviewCommand,
  validateWebviewMessage
} = require('../media/message-router');
const { createRunlistWebviewRouter } = require('../src/webview/webview-message-router');
const { readShippedHostSource } = require('./helpers/extension-source');

test('allowlists the complete host-to-webview message contract', () => {
  assert.deepEqual([...WEBVIEW_MESSAGE_TYPES].sort(), [
    'diagnosisRequestCopied',
    'outputCopied',
    'projectHttpPulse',
    'projectMetrics',
    'projectOutput',
    'projectOutputPeek',
    'restoreProjectMenuFocus'
  ]);
});

test('validates commands sent from the webview before routing', async () => {
  assert.ok(WEBVIEW_COMMAND_TYPES.has('saveProject'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('saveRunGroup'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('removeRunGroup'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('startProject'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('loadWorkspaceStack'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('showPortListening'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('choosePortResolve'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('loadWorkspaceStack'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('refreshPortListening'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('copyPortListeningDetails'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('revealPortOwnerProject'));
  assert.equal(validateWebviewCommand({ type: 'loadWorkspaceStack' })?.type, 'loadWorkspaceStack');
  assert.equal(validateWebviewCommand({ type: 'forceCloseProjectPorts', id: 'project-1', port: 70000 }), undefined);
  assert.equal(validateWebviewCommand({ type: 'forceCloseProjectPorts', id: 'project-1', port: 4310 })?.port, 4310);
  assert.equal(validateWebviewCommand({ type: 'copyPortListeningDetails', port: 0 }), undefined);
  assert.equal(validateWebviewCommand({ type: 'copyPortListeningDetails' })?.type, 'copyPortListeningDetails');
  assert.equal(validateWebviewCommand({ type: 'startProject', id: '' }), undefined);
  assert.equal(validateWebviewCommand({ type: 'copyServiceUrl', id: 'project-1', port: 70000 }), undefined);
  assert.equal(validateWebviewCommand({ type: 'resolveServicePort', id: 'project-1', port: 0 }), undefined);
  assert.equal(validateWebviewCommand({ type: 'resolveServicePort', id: 'project-1', port: 4310 })?.port, 4310);
  assert.equal(validateWebviewCommand({ type: 'choosePortResolve', action: 'temporary' })?.action, 'temporary');
  assert.equal(validateWebviewCommand({ type: 'choosePortResolve', action: 'nope' }), undefined);
  assert.equal(validateWebviewCommand({ type: 'loadWorkspaceStack' })?.type, 'loadWorkspaceStack');
  assert.equal(validateWebviewCommand({ type: 'openServiceUrl', id: 'project-1', port: 4310 })?.port, 4310);
  assert.equal(validateWebviewCommand({ type: 'registerAgent', agent: 'unknown' }), undefined);
  assert.equal(validateWebviewCommand({ type: 'startWorkspaceScript', script: 'build' }), undefined);
  assert.equal(validateWebviewCommand({ type: 'startWorkspaceScript', script: 'dev' })?.script, 'dev');
  assert.equal(validateWebviewCommand({ type: 'relinkProjectFolder', id: 'project-1' })?.type, 'relinkProjectFolder');
  assert.equal(validateWebviewCommand({ type: 'relinkProjectFolder', id: '' }), undefined);
  assert.ok(WEBVIEW_COMMAND_TYPES.has('relinkProjectFolder'));
  assert.equal(validateWebviewCommand({ type: 'setTagFilter', tag: 'frontend' })?.tag, 'frontend');
  assert.equal(validateWebviewCommand({ type: 'setTagFilter', tag: 'x'.repeat(33) }), undefined);

  const calls = [];
  const route = createWebviewCommandRouter({
    handlers: { startProject: async (message) => calls.push(message.id) }
  });
  assert.equal(await route({ type: 'startProject', id: 'project-1' }), true);
  assert.equal(await route({ type: 'unknown', id: 'project-2' }), false);
  assert.deepEqual(calls, ['project-1']);
});

test('maps validated webview commands to the provider boundary', async () => {
  const calls = [];
  const host = {
    forceCloseProjectPorts: async (id, intent) => calls.push(['force-close', id, intent]),
    relinkProjectFolder: async (id) => calls.push(['relink', id]),
    showAddProject: async (focus) => calls.push(['add', focus]),
    showProjectTransferLoadStack: async () => calls.push(['load-stack']),
    startProject: async (id) => calls.push(['start', id]),
    startWorkspaceScript: async (script) => calls.push(['start-script', script]),
    copyServiceUrl: async (id, port) => calls.push(['copy-service', id, port]),
    resolveServicePort: async (id, port) => calls.push(['resolve-service', id, port])
  };
  const route = createRunlistWebviewRouter(host);

  assert.equal(await route({ type: 'showAdd' }), true);
  assert.equal(await route({ type: 'loadWorkspaceStack' }), true);
  assert.equal(await route({ type: 'startWorkspaceScript', script: 'dev' }), true);
  assert.equal(await route({ type: 'startProject', id: 'project-1' }), true);
  assert.equal(await route({ type: 'relinkProjectFolder', id: 'project-3' }), true);
  assert.equal(await route({ type: 'relinkProjectFolder' }), false);
  assert.equal(await route({ type: 'forceCloseProjectPorts', id: 'project-1' }), true);
  assert.equal(await route({ type: 'forceCloseProjectPortsAndStart', id: 'project-2' }), true);
  assert.equal(await route({ type: 'copyServiceUrl', id: 'project-1', port: '4310' }), true);
  assert.equal(await route({ type: 'resolveServicePort', id: 'project-1', port: '4311' }), true);
  assert.equal(await route({ type: 'copyServiceUrl', id: 'project-1', port: 'bad' }), false);
  assert.deepEqual(calls, [
    ['add', { type: 'action', action: 'show-add' }],
    ['load-stack'],
    ['start-script', 'dev'],
    ['start', 'project-1'],
    ['relink', 'project-3'],
    ['force-close', 'project-1', 'stop'],
    ['force-close', 'project-2', 'start'],
    ['copy-service', 'project-1', 4310],
    ['resolve-service', 'project-1', 4311]
  ]);
});

test('forwards output peek incarnation requests without treating the token as authority', async () => {
  const calls = [];
  const route = createRunlistWebviewRouter({
    showProjectOutput: async (id, projectIncarnation) => {
      calls.push([id, projectIncarnation]);
    }
  });

  assert.equal(await route({
    type: 'showOutput',
    id: 'project-1',
    projectIncarnation: 'project-1:1'
  }), true);
  assert.equal(await route({
    type: 'showOutput',
    id: 'project-1',
    projectIncarnation: ''
  }), false);
  assert.deepEqual(calls, [['project-1', 'project-1:1']]);
});

test('keeps newer filter updates when messages arrive out of order', async () => {
  let renders = 0;
  const host = {
    filterRevision: 0,
    searchQuery: '',
    tagFilter: '',
    renderProjectList() {
      renders += 1;
    }
  };
  const route = createRunlistWebviewRouter(host);

  assert.equal(await route({
    type: 'setSearchQuery',
    query: 'new query',
    tag: 'frontend',
    filterRevision: 2,
    selectionStart: 0,
    selectionEnd: 0,
    searchFocused: false
  }), true);
  assert.equal(await route({
    type: 'setTagFilter',
    tag: 'stale',
    query: 'old query',
    filterRevision: 1,
    selectionStart: 0,
    selectionEnd: 0,
    searchFocused: false
  }), true);

  assert.equal(host.filterRevision, 2);
  assert.equal(host.searchQuery, 'new query');
  assert.equal(host.tagFilter, 'frontend');
  assert.equal(renders, 1);

  assert.equal(await route({
    type: 'setSearchQuery',
    query: '',
    tag: '',
    filterRevision: 3,
    selectionStart: 0,
    selectionEnd: 0,
    searchFocused: false
  }), true);
  assert.equal(host.searchQuery, '');
  assert.equal(host.tagFilter, '');
  assert.equal(renders, 2);
});

test('makes equal filter revisions idempotent and rejects legacy or invalid updates after versioning', async () => {
  let renders = 0;
  const host = {
    filterRevision: 0,
    searchQuery: 'query',
    tagFilter: 'frontend',
    searchSelectionStart: 1,
    searchSelectionEnd: 3,
    searchFocused: true,
    renderProjectList() {
      renders += 1;
    }
  };
  const route = createRunlistWebviewRouter(host);
  const current = {
    type: 'setSearchQuery',
    query: 'query',
    tag: 'FRONTEND',
    filterRevision: 1,
    selectionStart: 1,
    selectionEnd: 3,
    searchFocused: true
  };

  assert.equal(await route(current), true);
  assert.equal(await route({ ...current, query: 'changed' }), true);
  assert.equal(await route({ type: 'setTagFilter', tag: 'legacy' }), true);
  assert.equal(await route({
    ...current,
    filterRevision: 2,
    selectionStart: 4,
    selectionEnd: 2
  }), true);

  assert.equal(host.filterRevision, 1);
  assert.equal(host.searchQuery, 'query');
  assert.equal(host.tagFilter, 'frontend');
  assert.equal(host.searchSelectionStart, 1);
  assert.equal(host.searchSelectionEnd, 3);
  assert.equal(host.searchFocused, true);
  assert.equal(renders, 1);
});

test('uses locale-independent tag identity for Turkish-sensitive values', async () => {
  const originalLocaleLowerCase = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = function toTurkishLocaleLowerCase() {
    return this.toString().replaceAll('I', 'ı').replaceAll('İ', 'i').toLowerCase();
  };
  try {
    const host = {
      filterRevision: 0,
      searchQuery: '',
      tagFilter: '',
      renderProjectList() {}
    };
    const route = createRunlistWebviewRouter(host);
    await route({
      type: 'setTagFilter',
      query: '',
      tag: 'I',
      filterRevision: 1,
      selectionStart: 0,
      selectionEnd: 0,
      searchFocused: false
    });
    assert.equal(host.tagFilter, 'i');
  } finally {
    String.prototype.toLocaleLowerCase = originalLocaleLowerCase;
  }
});

test('rejects the wrong token, unknown types, and malformed payloads', () => {
  assert.equal(validateWebviewMessage({ type: 'outputCopied', messageToken: 'wrong' }, 'token'), undefined);
  assert.equal(validateWebviewMessage({ type: 'unknown', messageToken: 'token' }, 'token'), undefined);
  assert.equal(validateWebviewMessage({
    type: 'projectOutputPeek',
    messageToken: 'token',
    id: 'project-1',
    entries: 'not-an-array'
  }, 'token'), undefined);
  assert.equal(validateWebviewMessage({
    type: 'projectOutputPeek',
    messageToken: 'token',
    id: 'project-1',
    entries: [null]
  }, 'token'), undefined);
  assert.equal(validateWebviewMessage({
    type: 'projectOutputPeek',
    messageToken: 'token',
    id: 'project-1',
    entries: [{ kind: 'structured', level: {}, message: 'ready' }]
  }, 'token'), undefined);
  assert.equal(validateWebviewMessage({
    type: 'projectOutputPeek',
    messageToken: 'token',
    id: 'project-1',
    entries: [{ kind: 'raw', message: {} }]
  }, 'token'), undefined);
  assert.equal(validateWebviewMessage({
    type: 'restoreProjectMenuFocus',
    messageToken: 'token',
    id: ''
  }, 'token'), undefined);
});

test('accepts the bounded array histories published by runtime monitoring', () => {
  const message = {
    type: 'projectMetrics',
    messageToken: 'token',
    id: 'project-1',
    metrics: { available: true },
    runtimePulse: [{ at: 1, cpuPercent: 2 }],
    httpResponsePulse: [{ at: 1, durationMs: 20 }]
  };

  assert.equal(validateWebviewMessage(message, 'token'), message);
  assert.equal(validateWebviewMessage({
    type: 'projectHttpPulse',
    messageToken: 'token',
    id: 'project-1',
    httpResponsePulse: []
  }, 'token')?.type, 'projectHttpPulse');
});

test('routes one validated message to its exact handler', () => {
  const calls = [];
  const route = createWebviewMessageRouter({
    messageToken: 'token',
    handlers: {
      projectOutputPeek: (message) => calls.push(message.id)
    }
  });

  assert.equal(route({ data: {
    type: 'projectOutputPeek',
    messageToken: 'token',
    id: 'project-1',
    entries: []
  } }), true);
  assert.equal(route({ data: {
    type: 'projectOutputPeek',
    messageToken: 'wrong',
    id: 'project-2',
    entries: []
  } }), false);
  assert.deepEqual(calls, ['project-1']);
});

test('loads the router before the webview entry point and uses one message listener', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(
    extension,
    /message-router\.js[\s\S]*src="\$\{messageRouterUri\}"[\s\S]*src="\$\{projectActionsUri\}"[\s\S]*src="\$\{projectStatusUri\}"[\s\S]*src="\$\{scriptUri\}"/
  );
  assert.match(webview, /createWebviewMessageRouter\(\{[\s\S]*hostMessageHandlers/);
  assert.equal((webview.match(/window\.addEventListener\('message'/g) || []).length, 1);
});
