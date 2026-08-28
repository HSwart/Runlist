const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const host = readShippedHostSource(root);
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

function loadRunlistProvider() {
  const Module = require('node:module');
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

test('unknown-conflict primary posts resolveServicePort with the conflicted port', () => {
  assert.match(
    webview,
    /'resolve-port-conflict': \(\) => \{[\s\S]*type: 'resolveServicePort'[\s\S]*id: button\.dataset\.id[\s\S]*port/
  );
  assert.match(
    webview,
    /data-action="force-close-ports-and-start" data-id="\$\{projectId\}" role="menuitem"/
  );
  assert.match(webview, /'force-close-ports-and-start': \(\) => \{[\s\S]*type: 'forceCloseProjectPortsAndStart'/);
  assert.match(styles, /\.port-listening-row\.is-focused \{/);
  assert.match(webview, /port-listening-row\$\{port === Number\(report\.focusPort\) \? ' is-focused' : ''\}/);
});

test('resolveServicePort opens port-resolve when the overlay can be built', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-inspect-'));
  const Provider = loadRunlistProvider();
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    path.join(tempRoot, 'projects.json'),
    path.join(tempRoot, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  provider.render = () => {};
  provider.revealRunlistView = async () => {};
  provider.confirmDiscardProjectChanges = async () => true;
  provider.buildPortResolve = async (id, port) => ({
    projectId: id,
    projectName: 'API',
    serviceName: 'web',
    port,
    managed: false,
    choices: [{ label: 'Close this port and start', action: 'close' }]
  });

  const opened = await provider.resolveServicePort('api', 7072);
  assert.equal(opened, true);
  assert.equal(provider.mode, 'port-resolve');
  assert.equal(provider.portResolve.projectId, 'api');
  assert.equal(provider.portResolve.port, 7072);
  assert.deepEqual(provider.returnFocus, { type: 'project-control', id: 'api' });
});

test('resolveServicePort falls back to What\'s Listening without closing anything', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-port-inspect-'));
  const Provider = loadRunlistProvider();
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    path.join(tempRoot, 'projects.json'),
    path.join(tempRoot, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const calls = [];
  provider.render = () => {};
  provider.revealRunlistView = async () => {};
  provider.confirmDiscardProjectChanges = async () => true;
  provider.buildPortResolve = async (id, port) => {
    calls.push(['build', id, port]);
    return undefined;
  };
  provider.showPortListeningDiagnosis = async (options) => {
    calls.push(['listening', options]);
    return true;
  };

  const opened = await provider.resolveServicePort('api', 7072);
  assert.equal(opened, true);
  assert.deepEqual(calls, [
    ['build', 'api', 7072],
    ['listening', { focusPort: 7072, returnProjectId: 'api' }]
  ]);
  assert.doesNotMatch(host, /resolveServicePort\([\s\S]{0,400}forceCloseProjectPorts\(/);
});
