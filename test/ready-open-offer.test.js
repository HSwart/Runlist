const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readyOpenMessage,
  shouldOfferReadyOpen
} = require('../src/host/host-helpers');
const { upsertProject } = require('../src/projects/project-store');
const { readShippedHostSource } = require('./helpers/extension-source');

const readyOffer = {
  status: 'running',
  previewUrl: 'http://127.0.0.1:4310',
  locallyOwned: true,
  alreadyOpened: false,
  generation: 'gen-1'
};

function loadRunlistProvider(vscode) {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
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

function fixture(t, { informationChoice } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-ready-open-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'Demo app',
    folder,
    startCommand: 'npm run dev',
    services: [{ name: 'Web', port: 4310, url: 'http://127.0.0.1:4310' }]
  }, { reviewRequired: false }).project;
  const messages = [];
  const vscode = {
    env: {
      remoteName: undefined,
      openExternal: async () => true
    },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
      parse: (value) => ({ toString: () => String(value) })
    },
    window: {
      showErrorMessage(message) {
        messages.push({ type: 'error', message });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message) {
        messages.push({ type: 'warning', message });
        return Promise.resolve(undefined);
      },
      showInformationMessage(message, ...items) {
        messages.push({ type: 'information', message, items });
        return informationChoice
          ? informationChoice(message, items)
          : Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const Provider = loadRunlistProvider(vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.view = {
    webview: {
      cspSource: 'none',
      asWebviewUri: (uri) => uri,
      html: '',
      postMessage: () => Promise.resolve(true)
    }
  };
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { messages, project, provider };
}

function seedLocalRunning(provider, project, generation = 'gen-1') {
  const ownership = { token: generation, ownerAvailable: true, state: 'running' };
  provider.processes.set(project.id, { pid: 4242 });
  provider.managedProjectIds.add(project.id);
  provider.projectStatuses.set(project.id, 'running');
  provider.projectServiceUrls.set(project.id, [{ port: 4310, url: 'http://127.0.0.1:4310' }]);
  provider.projectRuntime.set(project.id, ownership);
  return new Map([[project.id, ownership]]);
}

test('offers ready Open only for a locally owned running preview', () => {
  assert.equal(shouldOfferReadyOpen(readyOffer), true);
  assert.equal(readyOpenMessage('Demo app'), 'Demo app is ready.');
});

test('does not offer ready Open for detected, failed, or incomplete starts', () => {
  for (const status of [
    'active',
    'stopped',
    'starting',
    'not-ready',
    'not-responding',
    'stopping',
    'ownership-lost',
    'unsupported'
  ]) {
    assert.equal(shouldOfferReadyOpen({ ...readyOffer, status }), false, status);
  }
  assert.equal(shouldOfferReadyOpen({ ...readyOffer, locallyOwned: false }), false);
  assert.equal(shouldOfferReadyOpen({ ...readyOffer, alreadyOpened: true }), false);
  assert.equal(shouldOfferReadyOpen({ ...readyOffer, previewUrl: '' }), false);
  assert.equal(shouldOfferReadyOpen({ ...readyOffer, previewUrl: undefined }), false);
  assert.equal(shouldOfferReadyOpen({ ...readyOffer, generation: '' }), false);
  assert.equal(shouldOfferReadyOpen({ ...readyOffer, pending: true }), false);
});

test('does not offer ready Open twice for the same generation', () => {
  assert.equal(shouldOfferReadyOpen(readyOffer), true);
  assert.equal(shouldOfferReadyOpen({
    ...readyOffer,
    offeredGeneration: 'gen-1'
  }), false);
  assert.equal(shouldOfferReadyOpen({
    ...readyOffer,
    generation: 'gen-2',
    offeredGeneration: 'gen-1'
  }), true);
});

test('shows one ready information message and opens through openProject', async (t) => {
  let resolveChoice;
  const choice = new Promise((resolve) => {
    resolveChoice = resolve;
  });
  const { messages, project, provider } = fixture(t, {
    informationChoice: () => choice
  });
  const opened = [];
  provider.openProject = async (id) => {
    opened.push(id);
  };
  const processRuntime = seedLocalRunning(provider, project);

  const offering = provider.offerReadyOpenNotifications([project], processRuntime);
  await provider.offerReadyOpenNotifications([project], processRuntime);
  assert.deepEqual(messages, [{
    type: 'information',
    message: 'Demo app is ready.',
    items: ['Open']
  }]);
  assert.deepEqual(opened, []);

  resolveChoice('Open');
  await offering;
  assert.deepEqual(opened, [project.id]);
});

test('does not prompt for detected processes or after the user already opened', async (t) => {
  const { messages, project, provider } = fixture(t);
  const detectedRuntime = seedLocalRunning(provider, project);
  provider.processes.delete(project.id);
  provider.projectStatuses.set(project.id, 'active');
  await provider.offerReadyOpenNotifications([project], detectedRuntime);
  assert.equal(messages.length, 0);

  const ownedRuntime = seedLocalRunning(provider, project, 'gen-open');
  provider.noteReadyOpenOpened(project.id);
  await provider.offerReadyOpenNotifications([project], ownedRuntime);
  assert.equal(messages.length, 0);
});

test('wires the ready Open prompt through the existing openProject path', () => {
  const host = readShippedHostSource();
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(host, /shouldOfferReadyOpen\(/);
  assert.match(host, /readyOpenMessage\(/);
  assert.match(host, /showInformationMessage\(\s*readyOpenMessage\(project\.name\),\s*'Open'\s*\)/);
  assert.match(host, /choice === 'Open'[\s\S]*this\.openProject\(project\.id\)/);
  assert.match(host, /offerReadyOpenNotifications\(/);
  assert.match(host, /noteReadyOpenOpened\(/);
  assert.doesNotMatch(host, /openExternal\([\s\S]{0,80}is ready/);
  assert.match(webview, /const canOpen = Boolean\(project\.previewUrl\)/);
  assert.match(
    webview,
    /aria-label="\$\{canOpen \? `Open \$\{projectName\} at \$\{escapeHtml\(project\.previewUrl \|\| `localhost\$\{portLabel\}`\)\}` : openTitle\}"/
  );
});
