const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertProject } = require('../src/projects/project-store');
const { stopAllConfirmation } = require('../src/lifecycle/project-lifecycle');
const { readShippedHostSource } = require('./helpers/extension-source');

function loadRunlistProvider(vscode) {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
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

function createProjectsFixture(root) {
  const projectsFile = path.join(root, 'projects.json');
  const firstFolder = path.join(root, 'first');
  const secondFolder = path.join(root, 'second');
  fs.mkdirSync(firstFolder, { recursive: true });
  fs.mkdirSync(secondFolder, { recursive: true });
  const first = upsertProject(projectsFile, {
    name: 'First',
    folder: firstFolder,
    startCommand: 'npm run first'
  }, { reviewRequired: false }).project;
  const second = upsertProject(projectsFile, {
    name: 'Second',
    folder: secondFolder,
    startCommand: 'npm run second'
  }, { reviewRequired: false }).project;
  return { first, second, projectsFile };
}

function mockLifecycle(stopAllCalls) {
  return {
    stopAll: () => stopAllCalls.push('stopAll'),
    beginShutdown: async () => {}
  };
}

test('stop-all confirmation names external listeners and other VS Code windows', () => {
  const confirmation = stopAllConfirmation(3);
  assert.equal(confirmation.message, 'Stop all running projects?');
  assert.equal(confirmation.confirmLabel, 'Stop all');
  assert.match(confirmation.detail, /external listeners/);
  assert.match(confirmation.detail, /other VS Code windows/);
  assert.match(confirmation.detail, /3 running projects/);
});

test('wires Stop all through a modal before lifecycle.stopAll runs', () => {
  const host = readShippedHostSource();
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(host, /async stopAllProjects\(\)/);
  assert.match(host, /stopAllConfirmation\(stoppableIds\.length\)/);
  assert.match(host, /showWarningMessage\([\s\S]*\{ modal: true, detail: confirmation\.detail \}/);
  assert.match(host, /choice !== confirmation\.confirmLabel[\s\S]*focusTarget = \{ type: 'action', action: 'stop-all' \}/);
  assert.match(host, /this\.lifecycle\.stopAll\(\)/);
  assert.doesNotMatch(
    webview,
    /'stop-all': \(\) => \{[\s\S]{0,200}button\.disabled = true/
  );
  assert.match(webview, /'stop-all': \(\) => \{[\s\S]*type: 'stopAllProjects'/);
});

test('cancel leaves every project running and restores Stop all focus', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-confirm-stop-all-'));
  const { first, second, projectsFile } = createProjectsFixture(root);
  const warnings = [];
  const stopAllCalls = [];
  const renderCalls = [];
  const vscode = {
    env: { remoteName: undefined },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage(message, options, confirmLabel) {
        warnings.push({ message, options, confirmLabel });
        return Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const Provider = loadRunlistProvider(vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.render = () => {};
  provider.renderProjectList = () => {
    renderCalls.push(provider.focusTarget);
  };
  provider.lifecycle = mockLifecycle(stopAllCalls);
  provider.processOwnership = { snapshot: () => new Map() };
  provider.projects = [first, second];
  provider.getProjectStatus = (id) => (id === first.id || id === second.id ? 'running' : 'stopped');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await provider.stopAllProjects();

  assert.equal(stopAllCalls.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].confirmLabel, 'Stop all');
  assert.match(warnings[0].options.detail, /external listeners/);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'stop-all' });
  assert.equal(renderCalls.length, 1);
});

test('confirm calls lifecycle.stopAll without changing per-project stop wiring', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-confirm-stop-all-confirm-'));
  const { first, second, projectsFile } = createProjectsFixture(root);
  const stopAllCalls = [];
  const vscode = {
    env: { remoteName: undefined },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage(message, options, confirmLabel) {
        return Promise.resolve(confirmLabel);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const Provider = loadRunlistProvider(vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.render = () => {};
  provider.renderProjectList = () => {};
  provider.lifecycle = mockLifecycle(stopAllCalls);
  provider.processOwnership = { snapshot: () => new Map() };
  provider.projects = [first, second];
  provider.getProjectStatus = () => 'running';
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await provider.stopAllProjects();

  assert.deepEqual(stopAllCalls, ['stopAll']);
});

test('does not confirm when only one project is stoppable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-confirm-stop-all-single-'));
  const { first, second, projectsFile } = createProjectsFixture(root);
  const warnings = [];
  const stopAllCalls = [];
  const vscode = {
    env: { remoteName: undefined },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage() {
        warnings.push('shown');
        return Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const Provider = loadRunlistProvider(vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.render = () => {};
  provider.lifecycle = mockLifecycle(stopAllCalls);
  provider.processOwnership = { snapshot: () => new Map() };
  provider.projects = [first, second];
  provider.getProjectStatus = (id) => (id === first.id ? 'running' : 'stopped');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await provider.stopAllProjects();

  assert.deepEqual(stopAllCalls, ['stopAll']);
  assert.equal(warnings.length, 0);
});
