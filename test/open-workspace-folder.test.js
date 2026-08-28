const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRunlistWebviewRouter } = require('../src/webview/webview-message-router');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const hostSource = readShippedHostSource(root);

function workspaceFolder(name, folder, scheme = 'file') {
  return {
    name,
    uri: { scheme, fsPath: folder }
  };
}

function loadRunlistProvider() {
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const dialogs = [];
  const commands = [];
  const errors = [];
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
      file: (folder) => ({ scheme: 'file', fsPath: folder })
    },
    commands: {
      executeCommand: async (...args) => {
        commands.push(args);
      }
    },
    window: {
      showOpenDialog: async (options) => {
        dialogs.push(options);
        return vscode.window.nextSelection;
      },
      showErrorMessage(message) {
        errors.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage() {
        return Promise.resolve(undefined);
      },
      showInformationMessage() {
        return Promise.resolve(undefined);
      },
      nextSelection: undefined
    },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders() {
        return { dispose() {} };
      }
    }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let Provider;
  try {
    providerModule._compile(source, providerPath);
    Provider = providerModule.exports.RunlistViewProvider;
  } finally {
    Module._load = originalLoad;
  }
  return { Provider, vscode, dialogs, commands, errors };
}

function createProvider(t, extras = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-open-folder-'));
  const projectsFile = path.join(rootDir, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  const loaded = loadRunlistProvider();
  Object.assign(loaded.vscode.workspace, extras.workspace || {});
  const provider = new loaded.Provider(
    { extensionUri: { fsPath: rootDir } },
    projectsFile,
    path.join(rootDir, 'mcp.js')
  );
  const renders = [];
  provider.render = () => {
    renders.push(provider.focusTarget);
  };
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  return { ...loaded, provider, renders };
}

test('empty-state Open folder uses the native picker in the current window', () => {
  assert.match(webview, /data-action="open-workspace-folder"/);
  assert.match(webview, /aria-label="Open a folder in this window"/);
  assert.match(webview, />Open folder</);
  assert.match(webview, /type: 'openWorkspaceFolder'/);
  assert.match(hostSource, /async openWorkspaceFolder\(\)/);
  assert.match(hostSource, /openLabel: 'Open folder'/);
  assert.match(hostSource, /openFolderInCurrentWindow\(vscode, selection\[0\]\)/);
  assert.doesNotMatch(
    hostSource.slice(
      hostSource.indexOf('async openWorkspaceFolder()'),
      hostSource.indexOf('async pickFolder(draft = {})')
    ),
    /saveProject\(|upsertProject\(|startProject\(/
  );
});

test('openWorkspaceFolder opens the picked folder in the current window', async (t) => {
  const { provider, vscode, dialogs, commands, errors, renders } = createProvider(t);
  const uri = { scheme: 'file', fsPath: '/Users/example/app' };
  vscode.window.nextSelection = [uri];

  assert.equal(await provider.openWorkspaceFolder(), true);
  assert.deepEqual(dialogs, [{
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Open folder'
  }]);
  assert.deepEqual(commands, [[
    'vscode.openFolder',
    uri,
    { forceNewWindow: false }
  ]]);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'show-add' });
  assert.deepEqual(errors, []);
  assert.deepEqual(renders, []);
  assert.equal(provider.mode, 'list');
  assert.deepEqual(provider.projects, []);
});

test('canceling the Open folder picker restores focus and changes nothing', async (t) => {
  const { provider, vscode, dialogs, commands, errors, renders } = createProvider(t);
  vscode.window.nextSelection = undefined;

  assert.equal(await provider.openWorkspaceFolder(), false);
  assert.equal(dialogs.length, 1);
  assert.deepEqual(commands, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'open-workspace-folder' });
  assert.deepEqual(renders, [{ type: 'action', action: 'open-workspace-folder' }]);
  assert.deepEqual(provider.projects, []);
});

test('openWorkspaceFolder does not replace a multi-root workspace', async (t) => {
  const { provider, dialogs, commands } = createProvider(t, {
    workspace: {
      workspaceFolders: [
        workspaceFolder('api', '/tmp/api'),
        workspaceFolder('web', '/tmp/web')
      ]
    }
  });

  assert.equal(await provider.openWorkspaceFolder(), false);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(commands, []);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'select-workspace-folder' });
});

test('openWorkspaceFolder does not replace an already open folder', async (t) => {
  const { provider, dialogs, commands } = createProvider(t, {
    workspace: {
      workspaceFolders: [workspaceFolder('app', '/tmp/app')]
    }
  });

  assert.equal(await provider.openWorkspaceFolder(), false);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(commands, []);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'show-add' });
});

test('openWorkspaceFolder restores Open folder focus when VS Code cannot open the folder', async (t) => {
  const { provider, vscode, commands, errors, renders } = createProvider(t);
  const uri = { scheme: 'file', fsPath: '/Users/example/app' };
  vscode.window.nextSelection = [uri];
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
    throw new Error('canceled');
  };

  assert.equal(await provider.openWorkspaceFolder(), false);
  assert.deepEqual(commands, [[
    'vscode.openFolder',
    uri,
    { forceNewWindow: false }
  ]]);
  assert.deepEqual(errors, ['Runlist could not open that folder.']);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'open-workspace-folder' });
  assert.deepEqual(renders, [{ type: 'action', action: 'open-workspace-folder' }]);
  assert.deepEqual(provider.projects, []);
});

test('routes openWorkspaceFolder from the webview without extra payload', async () => {
  const calls = [];
  const route = createRunlistWebviewRouter({
    openWorkspaceFolder: async () => {
      calls.push('opened');
    }
  });

  assert.equal(await route({ type: 'openWorkspaceFolder' }), true);
  assert.equal(await route({ type: 'open-workspace-folder' }), false);
  assert.deepEqual(calls, ['opened']);
});
