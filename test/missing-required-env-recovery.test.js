const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');
const { upsertProject } = require('../src/projects/project-store');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const host = readShippedHostSource(root);

function loadRunlistProvider() {
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage() { return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); }
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

test('host env recovery still keys off missing-required-env kind for persisted failures', () => {
  assert.match(
    host,
    /rowStartFailureSummary\(id, status\)[\s\S]*kind === MISSING_REQUIRED_ENV_FAILURE_KIND/
  );
});

test('showEditProject honors an env-map focus target', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-fix-env-'));
  const projectsFile = path.join(tempRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  const Provider = loadRunlistProvider();
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  provider.render = () => {};
  const folder = path.join(tempRoot, 'api');
  fs.mkdirSync(folder);
  const saved = upsertProject(projectsFile, {
    name: 'API',
    folder,
    startCommand: 'npm start',
    requiredEnvKeys: ['API_KEY']
  }, { reviewRequired: false }).project;

  provider.showEditProject(saved.id);
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'project-name' });
  assert.equal(provider.mode, 'edit');

  provider.showEditProject(saved.id, { focusTarget: 'env-map' });
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'env-map' });

  provider.showEditProject(saved.id, { focusTarget: 'not-a-field' });
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'project-name' });

  upsertProject(projectsFile, saved, { reviewRequired: true });
  provider.showEditProject(saved.id);
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'start-command' });
  provider.showEditProject(saved.id, { focusTarget: 'env-map' });
  assert.deepEqual(provider.focusTarget, { type: 'field', id: 'env-map' });
});

test('webview opens Edit with env-map focus from Fix environment', () => {
  assert.match(webview, /id="env-map"/);
  assert.match(
    webview,
    /'fix-environment': \(\) => vscode\.postMessage\(\{[\s\S]*type: 'showEdit'[\s\S]*focusTarget: button\.dataset\.focusTarget \|\| 'env-map'/
  );
  assert.match(webview, /target\.type === 'field'[\s\S]*getElementById\(target\.id\)/);
});
