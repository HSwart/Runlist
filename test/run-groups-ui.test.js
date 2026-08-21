const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

test('contributes run-group management to the Runlist view title', () => {
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.manageGroups'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'runlist.manageGroups'));
  assert.ok(manifest.contributes.menus['view/title'].some((entry) => (
    entry.command === 'runlist.manageGroups'
      && entry.when === 'view == runlist.projects'
  )));
});

test('renders compact keyboard-accessible group controls in the sidebar', () => {
  assert.match(webview, /<section class="run-groups" aria-label="Run groups">/);
  assert.match(webview, /data-action="start-group"[^>]*aria-label="Start group/);
  assert.match(webview, /data-action="stop-group"[^>]*aria-label="Stop group/);
  assert.match(webview, /data-action="manage-group"[^>]*aria-label="Manage group/);
  assert.match(webview, /data-action="toggle-run-group"[^>]*aria-expanded=/);
  assert.match(webview, /<label for="run-group-mode-/);
  assert.match(webview, /data-run-group-mode/);
  assert.match(webview, /'start-group': \(\) => vscode\.postMessage\(\{ type: 'startRunGroup'/);
  assert.match(webview, /'stop-group': \(\) => vscode\.postMessage\(\{ type: 'stopRunGroup'/);
});

test('routes group commands through the bounded group coordinator', () => {
  assert.match(extension, /new RunGroupCoordinator\(/);
  assert.match(router, /startRunGroup: \(message\) => host\.startSavedRunGroup\(message\.id\)/);
  assert.match(router, /stopRunGroup: \(message\) => host\.stopSavedRunGroup\(message\.id\)/);
  assert.match(router, /setRunGroupStartMode: \(message\) => host\.setRunGroupStartMode\(message\.id, message\.startMode\)/);
  assert.match(extension, /registerCommand\('runlist\.manageGroups'/);
});
