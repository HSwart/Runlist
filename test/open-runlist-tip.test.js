const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

test('activation offers a one-time Open Runlist tip when the list is empty', () => {
  assert.match(extensionSource, /runlist\.didShowOpenTip/);
  assert.match(
    extensionSource,
    /Open Runlist to save and control local apps\./
  );
  assert.match(extensionSource, /showInformationMessage\(/);
  assert.match(extensionSource, /'Open Runlist'/);
  assert.match(extensionSource, /revealRunlistView\(\)/);
  assert.match(extensionSource, /provider\.projects\.length === 0/);
  assert.match(extensionSource, /RUNLIST_EXTENSION_SMOKE/);
});

function loadExtension(vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode'
      ? vscode
      : originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  delete require.cache[require.resolve('../src/host/runlist-view-provider')];
  delete require.cache[require.resolve('../src/host/runlist-host-role')];
  try {
    return require('../extension');
  } finally {
    Module._load = originalLoad;
  }
}

test('shows Open Runlist tip once for an empty install and reveals on action', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-open-tip-'));
  const globalState = new Map();
  const information = [];
  let tipChoice = 'Open Runlist';
  let provider;
  const vscode = {
    version: '1.113.0',
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    workspace: {
      getConfiguration: () => ({ get: () => false })
    },
    window: {
      showErrorMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage(message, ...items) {
        information.push({ message, items });
        return Promise.resolve(tipChoice);
      },
      createOutputChannel: () => ({ dispose() {}, appendLine() {} }),
      registerWebviewViewProvider(_id, nextProvider) {
        provider = nextProvider;
        return { dispose() {} };
      }
    },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve(undefined);
      }
    },
    lm: {
      registerMcpServerDefinitionProvider() {
        return { dispose() {} };
      }
    },
    McpStdioServerDefinition: class {
      constructor() {}
    }
  };
  const extension = loadExtension(vscode);
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    globalState: {
      get(key, fallback) {
        return globalState.has(key) ? globalState.get(key) : fallback;
      },
      async update(key, value) {
        globalState.set(key, value);
      }
    },
    subscriptions: {
      push() {}
    },
    extensionUri: { fsPath: path.join(__dirname, '..') },
    extension: {
      packageJSON: require('../package.json'),
      extensionKind: 1
    }
  };

  const previousSmoke = process.env.RUNLIST_EXTENSION_SMOKE;
  delete process.env.RUNLIST_EXTENSION_SMOKE;
  t.after(async () => {
    if (previousSmoke === undefined) {
      delete process.env.RUNLIST_EXTENSION_SMOKE;
    } else {
      process.env.RUNLIST_EXTENSION_SMOKE = previousSmoke;
    }
    provider?.statusMonitoringDisposable?.dispose();
    fs.unwatchFile(path.join(storageRoot, 'projects.json'));
    try {
      await provider?.dispose?.();
    } catch {
      // Best-effort cleanup; storage root is removed next.
    }
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  extension.activate(context);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(information.length, 1);
  assert.equal(information[0].message, 'Open Runlist to save and control local apps.');
  assert.deepEqual(information[0].items, ['Open Runlist']);
  assert.equal(globalState.get('runlist.didShowOpenTip'), true);
});
