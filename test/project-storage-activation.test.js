const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadExtension(vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode'
      ? vscode
      : originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  delete require.cache[require.resolve('../src/host/runlist-view-provider')];
  delete require.cache[require.resolve('../src/host/runlist-host-role')];
  try {
    return require('../extension');
  } finally {
    Module._load = originalLoad;
  }
}

test('surfaces unrecoverable storage and stops activation', (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-activation-'));
  const projectsFile = path.join(storageRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '{ primary');
  fs.writeFileSync(`${projectsFile}.bak`, '{ backup');
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  const messages = [];
  const extension = loadExtension({
    window: {
      showErrorMessage(message) {
        messages.push(message);
        return Promise.resolve(undefined);
      }
    }
  });
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    globalState: { get: () => [] }
  };

  assert.throws(
    () => extension.activate(context),
    (error) => error.name === 'ProjectStoreError' && error.code === 'UNRECOVERABLE_STORAGE'
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /did not overwrite/i);
  assert.equal(fs.existsSync(path.join(storageRoot, 'mcp')), false);
});

test('activate registers Runlist commands and the projects webview', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-activate-register-'));
  const subscriptions = [];
  const commands = [];
  const views = [];
  const vscode = {
    version: '1.113.0',
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    workspace: {
      getConfiguration: () => ({ get: () => false })
    },
    window: {
      showErrorMessage: () => Promise.resolve(undefined),
      createOutputChannel: () => ({ dispose() {}, appendLine() {} }),
      registerWebviewViewProvider(id, provider) {
        views.push({ id, provider });
        return { dispose() {} };
      }
    },
    commands: {
      registerCommand(id) {
        commands.push(id);
        return { dispose() {} };
      }
    },
    lm: {
      registerMcpServerDefinitionProvider() {
        return { dispose() {} };
      }
    },
    McpStdioServerDefinition: class {
      constructor() {}
    }
  };
  const extension = loadExtension(vscode);
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    globalState: { get: () => [] },
    subscriptions: {
      push(...items) {
        subscriptions.push(...items);
      }
    },
    extensionUri: { fsPath: path.join(__dirname, '..') },
    extension: { packageJSON: require('../package.json') }
  };

  t.after(() => {
    views[0]?.provider?.statusMonitoringDisposable?.dispose();
    fs.unwatchFile(path.join(storageRoot, 'projects.json'));
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const result = extension.activate(context);
  assert.equal(result, undefined);
  assert.deepEqual(commands, [
    'runlist.addProject',
    'runlist.showAgentSetup',
    'runlist.transferProjects',
    'runlist.manageGroups',
    'runlist.copySupportDiagnostics'
  ]);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, 'runlist.projects');
  assert.equal(views[0].provider.constructor.name, 'RunlistViewProvider');
  assert.ok(subscriptions.length > 0);
});

test('does not activate the Windows UI host for Remote WSL', () => {
  const extension = loadExtension({
    env: { remoteName: 'wsl' },
    ExtensionKind: { UI: 1, Workspace: 2 }
  });
  const result = extension.activate({
    extension: { extensionKind: 1 },
    globalStorageUri: { fsPath: os.tmpdir() },
    globalState: { get: () => [] }
  });
  assert.deepEqual(result, { hostRole: { activate: false, reason: 'wsl-ui-defer' } });
});

test('does not activate workspace hosts for SSH and other remotes', () => {
  const extension = loadExtension({
    env: { remoteName: 'ssh-remote' }
  });
  const result = extension.activate({
    extension: { extensionKind: 2 },
    globalStorageUri: { fsPath: os.tmpdir() },
    globalState: { get: () => [] }
  });
  assert.deepEqual(result, { hostRole: { activate: false, reason: 'remote-workspace-skip' } });
});

