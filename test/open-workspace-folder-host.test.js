const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('openWorkspaceFolder opens the chosen folder in the current window', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-open-workspace-'));
  const projectsFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  const selected = path.join(root, 'chosen');
  fs.mkdirSync(selected);
  const calls = [];
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      file: (value) => ({ fsPath: value }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showOpenDialog: async () => [{ fsPath: selected }],
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    commands: {
      executeCommand: async (...args) => {
        calls.push(args);
      }
    },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: () => ({ dispose() {} })
    }
  };
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
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

  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await provider.openWorkspaceFolder();
  assert.deepEqual(calls, [
    [
      'vscode.openFolder',
      { fsPath: selected },
      { forceNewWindow: false }
    ]
  ]);
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'show-add' });
});

test('openWorkspaceFolder restores focus when the picker is canceled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-open-workspace-cancel-'));
  const projectsFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      file: (value) => ({ fsPath: value }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showOpenDialog: async () => undefined,
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    commands: {
      executeCommand: async () => {
        throw new Error('openFolder should not run when the picker is canceled');
      }
    },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: () => ({ dispose() {} })
    }
  };
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
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

  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await provider.openWorkspaceFolder();
  assert.deepEqual(provider.focusTarget, { type: 'action', action: 'open-workspace-folder' });
});
