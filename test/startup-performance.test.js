const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { bridgeFileNeedsCopy } = require('../extension');
const { readShippedHostSource } = require('./helpers/extension-source');

test('bridgeFileNeedsCopy skips unchanged MCP bridge files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-bridge-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.txt');
  const targetPath = path.join(root, 'target.txt');
  fs.writeFileSync(sourcePath, 'same');
  fs.writeFileSync(targetPath, 'same');
  assert.equal(bridgeFileNeedsCopy(sourcePath, targetPath), false);
  fs.writeFileSync(sourcePath, 'changed');
  assert.equal(bridgeFileNeedsCopy(sourcePath, targetPath), true);
});

test('installMcpBridge skips unchanged files on repeat activation', (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-bridge-install-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const extension = require('../extension');
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    extensionUri: { fsPath: process.cwd() }
  };
  const firstPath = extension.installMcpBridge(context);
  const serverPath = path.join(storageRoot, 'mcp', 'server.js');
  assert.equal(firstPath, serverPath);
  const beforeMtime = fs.statSync(serverPath).mtimeMs;
  extension.installMcpBridge(context);
  assert.equal(fs.statSync(serverPath).mtimeMs, beforeMtime);
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
  const source = readShippedHostSource('src/host/runlist-view-provider.js');
  assert.match(source, /renderLoadingShell\(\)/);
  assert.match(source, /Loading Runlist/);
  assert.match(
    source,
    /resolveWebviewView\(view\)[\s\S]*renderLoadingShell\(\)[\s\S]*setImmediate\(\(\) => \{[\s\S]*this\.render\(\)/
  );
});

test('Runlist defers the first status refresh until after activation', () => {
  const source = readShippedHostSource('src/host/runlist-view-provider.js');
  assert.match(
    source,
    /startStatusMonitoring\(\) \{[\s\S]*setImmediate\(\(\) => \{[\s\S]*refreshProjectStatuses\(\)/
  );
  assert.doesNotMatch(
    source,
    /startStatusMonitoring\(\) \{\s*this\.refreshProjectStatuses\(\);/
  );
});

test('Runlist caches projects by projects.json mtime during render', () => {
  const source = readShippedHostSource('src/host/runlist-view-provider.js');
  assert.match(source, /get projects\(\) \{[\s\S]*_projectsSnapshotMtime/);
});
