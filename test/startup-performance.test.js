const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

function loadExtension() {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode'
      ? {
        Uri: {
          joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath || base, ...parts) })
        }
      }
      : originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  try {
    return require('../extension');
  } finally {
    Module._load = originalLoad;
  }
}

test('bridgeFileNeedsCopy skips unchanged MCP bridge files', (t) => {
  const { bridgeFileNeedsCopy } = loadExtension();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-bridge-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.txt');
  const targetPath = path.join(root, 'target.txt');
  fs.writeFileSync(sourcePath, 'same');
  fs.writeFileSync(targetPath, 'same');
  assert.equal(bridgeFileNeedsCopy(sourcePath, targetPath), false);
  fs.copyFileSync(sourcePath, targetPath);
  assert.equal(bridgeFileNeedsCopy(sourcePath, targetPath), false);
  fs.writeFileSync(sourcePath, 'changed');
  assert.equal(bridgeFileNeedsCopy(sourcePath, targetPath), true);
});

test('installMcpBridge skips unchanged files on repeat activation', (t) => {
  const extension = loadExtension();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-bridge-install-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    extensionUri: { fsPath: process.cwd() }
  };
  const firstPath = extension.installMcpBridge(context);
  const serverPath = path.join(storageRoot, 'mcp', 'server.js');
  const sourcePath = path.join(process.cwd(), 'mcp', 'server.js');
  assert.equal(firstPath, serverPath);
  assert.equal(extension.bridgeFileNeedsCopy(sourcePath, serverPath), false);
  const copySpy = fs.copyFileSync;
  let copyCalls = 0;
  fs.copyFileSync = (...args) => {
    copyCalls += 1;
    return copySpy(...args);
  };
  t.after(() => {
    fs.copyFileSync = copySpy;
  });
  extension.installMcpBridge(context);
  assert.equal(copyCalls, 0);
});

test('Runlist defers stale port-lock cleanup during store construction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ports', 'port-gate.js'), 'utf8');
  assert.match(source, /scheduleStaleLockCleanup\(\)/);
  assert.doesNotMatch(
    source,
    /fs\.mkdirSync\(directory, \{ recursive: true \}\);\s*this\.withReservationTransaction\(\(\) => this\.removeStaleLocks\(\)\);/
  );
});

test('Runlist shows a loading shell before the first full render', () => {
  const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
    'utf8'
  );
  const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
  assert.match(providerSource, /renderLoadingShell\(\)/);
  assert.match(providerSource, /Loading Runlist/);
  assert.match(providerSource, /runlist\.svg/);
  assert.match(providerSource, /class="loading-shell"/);
  assert.match(styles, /\.loading-shell-logo/);
  assert.match(
    providerSource,
    /resolveWebviewView\(view\)[\s\S]*renderLoadingShell\(\)[\s\S]*setImmediate\(\(\) => \{[\s\S]*this\.render\(\)/
  );
});

test('Runlist defers the first status refresh until after activation', () => {
  const source = readShippedHostSource();
  assert.match(
    source,
    /startStatusMonitoring\(\) \{[\s\S]*setImmediate\(\(\) => \{[\s\S]*refreshProjectStatuses\(\)/
  );
  assert.doesNotMatch(
    source,
    /startStatusMonitoring\(\) \{\s*this\.refreshProjectStatuses\(\);/
  );
});

test('Runlist caches projects during render and invalidates on store changes', () => {
  const source = readShippedHostSource();
  assert.match(source, /get projects\(\) \{[\s\S]*_projectsSnapshotKey/);
  assert.match(source, /handleProjectStoreChange\(\)[\s\S]*invalidateProjectsSnapshot\(\)/);
});
