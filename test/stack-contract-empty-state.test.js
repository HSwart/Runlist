const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { serializeStackContract } = require('../src/projects/stack-contract');

test('stackContractEmptyState reports pending import counts for an empty list', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stack-empty-'));
  const projectsFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'worker'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runlist.json'), serializeStackContract({
    projects: [
      {
        id: 'api',
        name: 'API',
        folder: path.join(root, 'apps', 'api'),
        startCommand: 'npm run dev',
        services: [{ name: 'web', port: 3000 }]
      },
      {
        id: 'worker',
        name: 'Worker',
        folder: path.join(root, 'apps', 'worker'),
        startCommand: 'npm run worker',
        services: [{ name: 'worker', port: 4000 }]
      }
    ],
    groups: []
  }, { workspaceRoot: root }));

  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      file: (value) => ({ fsPath: value }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    commands: { executeCommand: async () => undefined },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root, scheme: 'file' }, name: path.basename(root) }],
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
  provider.projects = [];
  provider.preferredWorkspaceFolder = root;
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(provider.stackContractEmptyState(), {
    pending: true,
    changeCount: 2,
    addCount: 2,
    updateCount: 0
  });
  assert.equal(provider.stackContractPendingForEmptyState(), true);
});
