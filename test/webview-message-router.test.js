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
const { createRunlistWebviewRouter } = require('../webview-message-router');

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
  assert.ok(WEBVIEW_COMMAND_TYPES.has('startProject'));
  assert.equal(validateWebviewCommand({ type: 'startProject', id: '' }), undefined);
  assert.equal(validateWebviewCommand({ type: 'copyServiceUrl', id: 'project-1', port: 70000 }), undefined);
  assert.equal(validateWebviewCommand({ type: 'registerAgent', agent: 'unknown' }), undefined);

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
    showAddProject: async (focus) => calls.push(['add', focus]),
    startProject: async (id) => calls.push(['start', id]),
    copyServiceUrl: async (id, port) => calls.push(['copy-service', id, port])
  };
  const route = createRunlistWebviewRouter(host);

  assert.equal(await route({ type: 'showAdd' }), true);
  assert.equal(await route({ type: 'startProject', id: 'project-1' }), true);
  assert.equal(await route({ type: 'copyServiceUrl', id: 'project-1', port: '4310' }), true);
  assert.equal(await route({ type: 'copyServiceUrl', id: 'project-1', port: 'bad' }), false);
  assert.deepEqual(calls, [
    ['add', { type: 'action', action: 'show-add' }],
    ['start', 'project-1'],
    ['copy-service', 'project-1', 4310]
  ]);
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
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /message-router\.js[\s\S]*src="\$\{messageRouterUri\}"[\s\S]*src="\$\{scriptUri\}"/);
  assert.match(webview, /createWebviewMessageRouter\(\{[\s\S]*hostMessageHandlers/);
  assert.equal((webview.match(/window\.addEventListener\('message'/g) || []).length, 1);
});
