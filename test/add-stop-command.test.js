const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertProject } = require('../src/projects/project-store');
const { readShippedHostSource } = require('./helpers/extension-source');

function loadRunlistProvider() {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
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
      showWarningMessage() { return Promise.resolve(undefined); }
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

test('Add stop command opens Edit with the stop command field focused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-add-stop-command-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'App',
    folder,
    startCommand: 'npm run dev',
    services: []
  }, { reviewRequired: false }).project;
  const Provider = loadRunlistProvider();
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.render = () => {};
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  provider.showEditProject(project.id, { focusField: 'stop-command' });
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'stop-command' });
  assert.equal(provider.mode, 'edit');

  provider.showEditProject(project.id);
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'project-name' });
});

test('Add stop command never starts, stops, or force-closes ports', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const host = readShippedHostSource();
  const router = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'webview', 'webview-message-router.js'),
    'utf8'
  );

  assert.match(
    webview,
    /'add-stop-command': \(\) => vscode\.postMessage\(\{ type: 'showEdit', id: button\.dataset\.id, focusField: 'stop-command' \}\)/
  );
  assert.doesNotMatch(
    webview,
    /'add-stop-command': \(\) => \{[\s\S]{0,400}forceCloseProjectPorts/
  );
  assert.match(router, /showEdit: \(message\) => host\.showEditProject\(message\.id/);
  assert.match(host, /showEditProject\(id, options = \{\}\)/);
  assert.match(host, /focusField === 'stop-command'/);
  assert.doesNotMatch(host, /add-stop-command[\s\S]{0,200}forceCloseProjectPorts/);
});
