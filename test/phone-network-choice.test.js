const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertProject } = require('../src/projects/project-store');
const { createPhoneHandoff } = require('../src/webview/phone-handoff');
const { WEBVIEW_COMMAND_TYPES, validateWebviewCommand } = require('../media/message-router');

const root = path.join(__dirname, '..');
const multiNetwork = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'Wi-Fi': [{ address: '192.168.68.42', family: 'IPv4', internal: false }],
  Ethernet: [{ address: '10.20.30.40', family: 4, internal: false }],
  'vEthernet (WSL)': [{ address: '172.21.0.1', family: 'IPv4', internal: false }]
};

function loadRunlistProvider(vscode) {
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
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

function parseWebviewState(html) {
  const marker = 'window.runlistState = ';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, 'webview state was written');
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(';</script>', jsonStart);
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function fixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-phone-network-'));
  const projectsFile = path.join(tempRoot, 'projects.json');
  const folder = path.join(tempRoot, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'Demo app',
    folder,
    startCommand: 'npm run dev',
    services: [{ name: 'Web', port: 4310, url: 'http://127.0.0.1:4310/' }]
  }, { reviewRequired: false }).project;
  const picks = [];
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage() { return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); },
      showQuickPick: async (items, options) => {
        picks.push({ items, options });
        return vscode.window.nextPick;
      },
      nextPick: undefined
    },
    workspace: { workspaceFolders: [] }
  };
  const Provider = loadRunlistProvider(vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  provider.view = {
    webview: {
      cspSource: 'none',
      asWebviewUri: (uri) => uri,
      html: '',
      postMessage: () => Promise.resolve(true)
    }
  };
  provider.readNetworkInterfaces = () => multiNetwork;
  provider.projectStatuses.set(project.id, 'running');
  provider.projectServiceUrls.set(project.id, [
    { port: 4310, url: 'http://127.0.0.1:4310/' }
  ]);
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return { picks, project, provider, vscode };
}

test('allowlists choosePhoneNetwork from the webview', () => {
  assert.ok(WEBVIEW_COMMAND_TYPES.has('choosePhoneNetwork'));
  assert.equal(validateWebviewCommand({ type: 'choosePhoneNetwork', id: 'app' })?.type, 'choosePhoneNetwork');
  assert.equal(validateWebviewCommand({ type: 'choosePhoneNetwork' }), undefined);
  assert.equal(
    validateWebviewCommand({ type: 'choosePhoneNetwork', id: 'app', changeNetwork: true }).changeNetwork,
    true
  );
  assert.equal(
    validateWebviewCommand({ type: 'choosePhoneNetwork', id: 'app', changeNetwork: 'yes' }),
    undefined
  );
});

test('mocked Quick Pick selection produces phoneHandoff for the chosen LAN', async (t) => {
  const { picks, project, provider, vscode } = fixture(t);
  vscode.window.nextPick = {
    label: 'Wi-Fi \u2014 192.168.68.42',
    address: '192.168.68.42'
  };

  await provider.choosePhoneNetwork(project.id);

  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0].items.map((item) => item.address).sort(), [
    '10.20.30.40',
    '192.168.68.42'
  ]);
  assert.equal(picks[0].options.title, 'Choose a network for your phone');
  assert.equal(provider.phoneHandoffLanAddress, '192.168.68.42');
  assert.equal(provider.expandedPreviewProjectId, project.id);

  const state = parseWebviewState(provider.view.webview.html);
  const row = state.projects.find((item) => item.id === project.id);
  const expected = createPhoneHandoff(
    'http://127.0.0.1:4310/',
    multiNetwork,
    '192.168.68.42'
  );
  assert.equal(row.canChoosePhoneNetwork, true);
  assert.equal(row.phoneHandoff.url, expected.url);
  assert.equal(row.phoneHandoff.qrSvg, expected.qrSvg);
  assert.match(row.phoneHandoff.url, /http:\/\/192\.168\.68\.42:4310\//);
});

test('remembers the chosen network for the window session without prompting again', async (t) => {
  const { picks, project, provider, vscode } = fixture(t);
  vscode.window.nextPick = { address: '10.20.30.40' };

  await provider.choosePhoneNetwork(project.id);
  await provider.choosePhoneNetwork(project.id);

  assert.equal(picks.length, 1);
  assert.equal(provider.phoneHandoffLanAddress, '10.20.30.40');
  const state = parseWebviewState(provider.view.webview.html);
  const row = state.projects.find((item) => item.id === project.id);
  assert.equal(row.phoneHandoff.url, 'http://10.20.30.40:4310/');
});

test('Change network reopens the picker and Cancel leaves the previous choice', async (t) => {
  const { picks, project, provider, vscode } = fixture(t);
  vscode.window.nextPick = { address: '192.168.68.42' };
  await provider.choosePhoneNetwork(project.id);

  vscode.window.nextPick = undefined;
  await provider.choosePhoneNetwork(project.id, { changeNetwork: true });

  assert.equal(picks.length, 2);
  assert.equal(provider.phoneHandoffLanAddress, '192.168.68.42');
  const state = parseWebviewState(provider.view.webview.html);
  const row = state.projects.find((item) => item.id === project.id);
  assert.equal(row.phoneHandoff.url, 'http://192.168.68.42:4310/');
});
