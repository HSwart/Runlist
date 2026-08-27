const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');

test('Global overflow hub is always available and does not add a Tools section', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const host = readShippedHostSource(root);
  const overflow = (manifest.contributes.submenus || []).find((item) => (
    item.id === 'runlist.globalOverflow'
  ));
  const viewTitle = manifest.contributes.menus['view/title'] || [];
  const overflowItems = manifest.contributes.menus['runlist.globalOverflow'] || [];

  assert.equal(overflow?.icon, '$(ellipsis)');
  assert.ok(viewTitle.some((entry) => (
    entry.submenu === 'runlist.globalOverflow'
      && entry.when === 'view == runlist.projects'
  )), 'overflow must show for 0 and 1 project views');
  assert.equal(
    viewTitle.filter((entry) => entry.group?.startsWith('navigation')).length,
    2,
    'titlebar keeps Add + overflow only so the list stays the hero'
  );
  assert.match(JSON.stringify(overflowItems), /showAgentSetup/);
  assert.match(JSON.stringify(overflowItems), /transferProjects/);
  assert.match(JSON.stringify(overflowItems), /loadWorkspaceStack/);
  assert.match(JSON.stringify(overflowItems), /manageGroups/);
  assert.match(JSON.stringify(overflowItems), /showPortListening/);
  assert.match(JSON.stringify(overflowItems), /copySupportDiagnostics/);
  assert.doesNotMatch(webview, /class="[^"]*tools-(?:section|strip|accordion)/);
  assert.doesNotMatch(webview, />\s*Tools\s*</);
  assert.doesNotMatch(host, /showTitlebarExtras/);
  assert.doesNotMatch(host, /syncTitlebarContext/);
});
