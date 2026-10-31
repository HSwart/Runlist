const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { serializeStackContract } = require('../src/projects/stack-contract');
const { writeProjects } = require('../src/projects/project-store');

test('stack contract attention reports pending stack changes when projects exist', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stack-attention-'));
  const projectsFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runlist.json'), serializeStackContract({
    projects: [{
      id: 'api',
      name: 'API',
      folder: path.join(root, 'apps', 'api'),
      startCommand: 'npm run dev',
      services: [{ name: 'web', port: 3000 }]
    }],
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
  const existingFolder = path.join(root, 'existing');
  fs.mkdirSync(existingFolder, { recursive: true });
  writeProjects(projectsFile, [{
    id: 'existing',
    name: 'Existing',
    folder: existingFolder,
    startCommand: 'npm start',
    services: [],
    reviewRequired: false
  }]);
  provider.invalidateProjectsSnapshot();
  provider.preferredWorkspaceFolder = root;
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.ok(provider.projects.length > 0);
  assert.deepEqual(provider.stackContractSummary(), {
    pending: true,
    changeCount: 1,
    addCount: 1,
    updateCount: 0
  });
});
