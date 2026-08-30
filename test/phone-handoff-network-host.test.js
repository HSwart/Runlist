const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertProject } = require('../src/projects/project-store');

function loadRunlistProvider(osModule = os) {
  const root = path.join(__dirname, '..');
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    env: {
      remoteName: undefined,
      clipboard: { writeText: async () => {} }
    },
    Uri: {
      file: (value) => ({ fsPath: value }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showQuickPick: async () => undefined,
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    commands: { executeCommand: async () => undefined },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: () => ({ dispose() {} })
    }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    if (request === 'node:os') {
      return osModule;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    providerModule._compile(source, providerPath);
    return { Provider: providerModule.exports.RunlistViewProvider, vscode };
  } finally {
    Module._load = originalLoad;
  }
}

test('openPhoneHandoff prompts for a network when multiple LAN addresses exist', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-phone-network-'));
  const projectsFile = path.join(tempRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  const multiNetworkOs = {
    networkInterfaces: () => ({
      WiFi: [{ address: '192.168.68.42', family: 'IPv4', internal: false }],
      Ethernet: [{ address: '10.20.30.40', family: 4, internal: false }]
    })
  };
  const { Provider, vscode } = loadRunlistProvider(multiNetworkOs);
  const quickPicks = [];
  vscode.window.showQuickPick = async (items) => {
    quickPicks.push(items);
    return items[1];
  };
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  const { project } = upsertProject(projectsFile, {
    name: 'API',
    folder: tempRoot,
    startCommand: 'node server.js',
    services: [{ name: 'Web', port: 3000 }]
  }, { reviewRequired: false });
  provider.projects = [project];
  provider.getProjectStatus = () => 'running';
  provider.projectServiceUrls.set(project.id, [{ port: 3000, url: 'http://localhost:3000/' }]);
  provider.projectPortConflicts = new Map();
  provider.toggleProjectPreview = (id, focusAction) => {
    provider.previewCalls = [{ id, focusAction }];
  };
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await provider.openPhoneHandoff(project.id);
  assert.equal(quickPicks.length, 1);
  assert.equal(provider.phoneHandoffNetworkChoice, '10.20.30.40');
  assert.deepEqual(provider.previewCalls, [{ id: project.id, focusAction: 'focus-phone-handoff' }]);
});
