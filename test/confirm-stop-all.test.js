const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { confirmStopAllProjects } = require('../src/lifecycle/confirm-stop-all');
const { stoppableProjectIds } = require('../src/lifecycle/project-status');
const {
  WEBVIEW_MESSAGE_TYPES,
  validateWebviewMessage
} = require('../media/message-router');
const { createRunlistWebviewRouter } = require('../src/webview/webview-message-router');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webviewSource = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const hostSource = readShippedHostSource(root);

function namedProjects(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `project-${index + 1}`,
    name: `App ${index + 1}`,
    status: 'running'
  }));
}

function loadRunlistProvider(showWarningMessage) {
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    env: { remoteName: undefined },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage: showWarningMessage || (() => Promise.resolve(undefined))
    },
    workspace: { workspaceFolders: [] }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    providerModule._compile(source, providerPath);
    return providerModule.exports.RunlistViewProvider;
  } finally {
    Module._load = originalLoad;
  }
}

function stopAllHost({
  projects,
  statuses,
  showWarningMessage,
  stopAll = () => {}
} = {}) {
  const Provider = loadRunlistProvider(showWarningMessage);
  const provider = Object.create(Provider.prototype);
  const posted = [];
  let renderCount = 0;
  Object.defineProperty(provider, 'projects', {
    configurable: true,
    get() {
      return projects;
    }
  });
  provider.processOwnership = { snapshot: () => new Map() };
  provider.getProjectStatus = (id) => statuses[id] || 'stopped';
  provider.lifecycle = { stopAll };
  provider.webviewMessageToken = 'token';
  provider.view = {
    webview: {
      postMessage(message) {
        posted.push(message);
        return Promise.resolve(true);
      }
    }
  };
  provider.render = () => {
    renderCount += 1;
  };
  return {
    provider,
    posted,
    renderCount: () => renderCount
  };
}

test('confirmStopAllProjects returns false on cancel and true on confirm', async () => {
  const projects = namedProjects(3);
  const calls = [];

  assert.equal(await confirmStopAllProjects({
    projects,
    count: 3,
    showWarningMessage: async (message, options, confirm) => {
      calls.push({ message, options, confirm });
      return undefined;
    }
  }), false);

  assert.equal(await confirmStopAllProjects({
    projects,
    count: 3,
    showWarningMessage: async (_message, _options, confirm) => confirm
  }), true);

  assert.equal(calls[0].message, 'Stop all running projects?');
  assert.equal(calls[0].options.modal, true);
  assert.equal(calls[0].confirm, 'Stop all');
  assert.match(calls[0].options.detail, /This stops 3 projects Runlist controls from this window/);
  assert.match(calls[0].options.detail, /Projects running elsewhere or without a stop command are not affected/);
  assert.match(calls[0].options.detail, /External listeners are not closed/);
  assert.match(calls[0].options.detail, /App 1, App 2, App 3/);
});

test('confirmStopAllProjects bounds listed project names', async () => {
  const projects = namedProjects(10);
  const details = [];
  await confirmStopAllProjects({
    projects,
    count: 10,
    showWarningMessage: async (_message, options) => {
      details.push(options.detail);
    }
  });
  assert.match(details[0], /App 1, App 2, App 3, App 4, App 5, App 6, App 7, App 8, and 2 more/);
  assert.doesNotMatch(details[0], /App 9/);
  assert.doesNotMatch(details[0], /App 10/);
});

test('confirmed Stop all calls lifecycle.stopAll once', async () => {
  const projects = namedProjects(2);
  const stops = [];
  const { provider, posted } = stopAllHost({
    projects,
    statuses: { 'project-1': 'running', 'project-2': 'running' },
    showWarningMessage: async (_message, _options, confirm) => confirm,
    stopAll: () => stops.push('stop-all')
  });

  await provider.stopAllProjects();

  assert.deepEqual(stops, ['stop-all']);
  assert.equal(posted.some((message) => message.type === 'restoreStopAllButton'), false);
});

test('cancelled Stop all never stops and restores the header button', async () => {
  const projects = namedProjects(2);
  const stops = [];
  const { provider, posted, renderCount } = stopAllHost({
    projects,
    statuses: { 'project-1': 'running', 'project-2': 'running' },
    showWarningMessage: async () => undefined,
    stopAll: () => stops.push('stop-all')
  });

  await provider.stopAllProjects();

  assert.deepEqual(stops, []);
  assert.deepEqual(posted, [{
    type: 'restoreStopAllButton',
    messageToken: 'token'
  }]);
  assert.equal(renderCount(), 0);
});

test('Stop all cancels quietly when the stoppable set drops to one project', async () => {
  const projects = namedProjects(2);
  const stops = [];
  const { provider, posted, renderCount } = stopAllHost({
    projects,
    statuses: { 'project-1': 'running', 'project-2': 'stopped' },
    showWarningMessage: async () => {
      throw new Error('modal should not open when fewer than two projects are stoppable');
    },
    stopAll: () => stops.push('stop-all')
  });

  await provider.stopAllProjects();

  assert.deepEqual(stops, []);
  assert.equal(posted.some((message) => message.type === 'restoreStopAllButton'), true);
  assert.equal(renderCount(), 1);
});

test('Stop all does not stop when the set drops to 0-1 after confirm', async () => {
  const projects = namedProjects(2);
  const stops = [];
  const remaining = { 'project-1': 'running', 'project-2': 'running' };
  const { provider, posted, renderCount } = stopAllHost({
    projects,
    statuses: remaining,
    showWarningMessage: async (_message, _options, confirm) => {
      remaining['project-2'] = 'stopped';
      return confirm;
    },
    stopAll: () => stops.push('stop-all')
  });
  provider.getProjectStatus = (id) => remaining[id] || 'stopped';

  await provider.stopAllProjects();

  assert.deepEqual(stops, []);
  assert.equal(posted.some((message) => message.type === 'restoreStopAllButton'), true);
  assert.equal(renderCount(), 1);
});

test('overlapping Stop all clicks share one confirmation and one stop', async () => {
  const projects = namedProjects(2);
  const stops = [];
  let releaseConfirm;
  const confirmation = new Promise((resolve) => {
    releaseConfirm = resolve;
  });
  const { provider } = stopAllHost({
    projects,
    statuses: { 'project-1': 'running', 'project-2': 'running' },
    showWarningMessage: async (_message, _options, confirm) => {
      await confirmation;
      return confirm;
    },
    stopAll: () => stops.push('stop-all')
  });

  const first = provider.stopAllProjects();
  const second = provider.stopAllProjects();
  releaseConfirm('Stop all');
  await Promise.all([first, second]);

  assert.deepEqual(stops, ['stop-all']);
});

test('clicking Stop all posts a host confirmation request instead of stopping locally', async () => {
  const calls = [];
  const route = createRunlistWebviewRouter({
    stopAllProjects: async () => calls.push('stopAllProjects')
  });

  assert.equal(await route({ type: 'stopAllProjects' }), true);
  assert.deepEqual(calls, ['stopAllProjects']);
  assert.match(
    webviewSource,
    /'stop-all': \(\) => \{[\s\S]*?button\.disabled = true;[\s\S]*?Stopping all…[\s\S]*?postMessage\(\{ type: 'stopAllProjects' \}\)/
  );
  assert.doesNotMatch(webviewSource, /lifecycle\.stopAll/);
  assert.match(hostSource, /await confirmStopAllProjects\(/);
  assert.match(hostSource, /this\.lifecycle\.stopAll\(\)/);
});

test('restoreStopAllButton re-enables the header control and returns focus', () => {
  assert.ok(WEBVIEW_MESSAGE_TYPES.has('restoreStopAllButton'));
  assert.equal(validateWebviewMessage({
    type: 'restoreStopAllButton',
    messageToken: 'token'
  }, 'token')?.type, 'restoreStopAllButton');
  assert.match(
    webviewSource,
    /restoreStopAllButton: \(\) => \{[\s\S]*?\.stop-all-button\[data-action="stop-all"\][\s\S]*?button\.disabled = false;[\s\S]*?Stop all \(\$\{state\.stopAllCount\}\)[\s\S]*?button\.focus\(\)/
  );
});

test('single-project rows never show Stop all and stoppableProjectIds stays the same', () => {
  const projects = [
    { id: 'running', status: 'running' },
    { id: 'starting', status: 'starting' },
    { id: 'not-ready', status: 'not-ready' },
    { id: 'not-responding', status: 'not-responding' },
    { id: 'detected-without-stop', status: 'active' },
    { id: 'detected-with-custom-stop', status: 'active', stopCommand: 'docker compose down' },
    { id: 'pending-review', status: 'running', reviewRequired: true },
    { id: 'stopping', status: 'stopping' },
    { id: 'stopped', status: 'stopped' },
    { id: 'conflict', status: 'port-in-use' },
    { id: 'unknown-owner', status: 'port-in-use-unknown' },
    { id: 'ownership-lost', status: 'ownership-lost' },
    { id: 'ownership-lost-custom', status: 'ownership-lost', stopCommand: 'docker compose down' }
  ];
  assert.deepEqual(stoppableProjectIds(projects), [
    'running',
    'starting',
    'not-ready',
    'not-responding',
    'detected-with-custom-stop',
    'ownership-lost-custom'
  ]);
  assert.match(webviewSource, /state\.stopAllCount > 1/);
  assert.doesNotMatch(
    webviewSource,
    /'stop': \(\) => vscode\.postMessage\(\{ type: 'stopAllProjects'/
  );
  assert.doesNotMatch(
    webviewSource,
    /'stop-group': \(\) => \{[\s\S]*?stopAllProjects/
  );
});
