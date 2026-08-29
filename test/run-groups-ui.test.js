const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const extension = readShippedHostSource(root);
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const { validateWebviewCommand } = require('../media/message-router');

test('contributes run-group management through the Global overflow hub', () => {
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.manageGroups'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'runlist.manageGroups'));
  assert.ok((manifest.contributes.menus['runlist.globalOverflow'] || []).some((entry) => (
    entry.command === 'runlist.manageGroups'
  )));
  assert.equal(
    (manifest.contributes.menus['view/title'] || []).some((entry) => (
      entry.command === 'runlist.manageGroups'
    )),
    false
  );
});

test('opens Manage Groups as a sidebar editor screen instead of Quick Pick', () => {
  assert.match(extension, /async showRunGroupManager\(/);
  assert.match(extension, /this\.mode = 'run-groups'/);
  assert.doesNotMatch(extension, /runGroupManagementWorkflow\(/);
  assert.match(webview, /function renderRunGroupsEditor\(/);
  assert.match(webview, /state\.mode === 'run-groups'/);
  assert.match(webview, /data-action="create-run-group"/);
  assert.match(webview, /data-action="save-run-group-draft"/);
  assert.match(webview, /data-action="edit-run-group"/);
  assert.match(webview, /data-action="remove-run-group"/);
  assert.match(router, /saveRunGroup: \(message\) => host\.saveRunGroupFromEditor\(message\.group\)/);
  assert.match(router, /removeRunGroup: \(message\) => host\.removeRunGroupFromEditor\(message\.id\)/);
});

test('uses Add to group copy in the run-group draft form and quick pick', () => {
  const runGroups = fs.readFileSync(path.join(root, 'src', 'groups', 'run-groups.js'), 'utf8');
  assert.match(webview, /for="run-group-add-project">Add to group</);
  assert.doesNotMatch(webview, /for="run-group-add-project">Add project</);
  assert.match(runGroups, /label: '\$\(add\) Add to group'/);
  assert.doesNotMatch(runGroups, /label: '\$\(add\) Add project'/);
});

test('keeps group UI filter-weight with Start/Stop and hides it when empty', () => {
  assert.doesNotMatch(webview, /<section class="run-groups"/);
  assert.doesNotMatch(styles, /\.run-groups\s*\{/);
  assert.match(webview, /function groupFilterHtml\(/);
  assert.match(webview, /if \(!state\.groups\?\.length\) \{\s*return '';/);
  assert.match(webview, /<section class="project-group-filter" aria-label="Run group filter">/);
  assert.match(webview, /data-action="toggle-group-filter"/);
  assert.match(webview, /data-action="select-group-filter"/);
  assert.match(webview, /data-action="start-group"[^>]*aria-label="Start group/);
  assert.match(webview, /data-action="stop-group"[^>]*aria-label="Stop group/);
  assert.match(webview, /'start-group': \(\) => vscode\.postMessage\(\{ type: 'startRunGroup'/);
  assert.match(webview, /'stop-group': \(\) => vscode\.postMessage\(\{ type: 'stopRunGroup'/);
  assert.match(styles, /\.project-group-filter\s*\{/);
  assert.match(styles, /max-height:\s*144px/);
});

test('routes group commands through the bounded group coordinator', () => {
  assert.match(extension, /new RunGroupCoordinator\(/);
  assert.match(router, /startRunGroup: \(message\) => host\.startSavedRunGroup\(message\.id\)/);
  assert.match(router, /stopRunGroup: \(message\) => host\.stopSavedRunGroup\(message\.id\)/);
  assert.match(router, /setRunGroupStartMode: \(message\) => host\.setRunGroupStartMode\(message\.id, message\.startMode\)/);
  assert.match(extension, /registerCommand\('runlist\.manageGroups'/);
});

test('validates saveRunGroup and removeRunGroup webview payloads', () => {
  assert.equal(validateWebviewCommand({
    type: 'saveRunGroup',
    group: {
      name: 'Daily',
      projectIds: ['project-1'],
      startMode: 'sequential'
    }
  })?.type, 'saveRunGroup');
  assert.equal(validateWebviewCommand({
    type: 'saveRunGroup',
    group: { name: '', projectIds: ['project-1'] }
  }), undefined);
  assert.equal(validateWebviewCommand({
    type: 'saveRunGroup',
    group: { name: 'Daily', projectIds: [] }
  }), undefined);
  assert.equal(validateWebviewCommand({
    type: 'saveRunGroup',
    group: { name: 'Daily', projectIds: ['project-1'], startMode: 'later' }
  }), undefined);
  assert.equal(validateWebviewCommand({ type: 'removeRunGroup', id: 'group-1' })?.id, 'group-1');
  assert.equal(validateWebviewCommand({ type: 'removeRunGroup', id: '' }), undefined);
});
