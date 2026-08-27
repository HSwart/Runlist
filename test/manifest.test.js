const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('ships as a local UI extension with a Marketplace icon', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.deepEqual(manifest.extensionKind, ['workspace', 'ui']);
  assert.equal(manifest.icon, 'media/runlist.png');
  assert.equal(fs.existsSync(path.join(root, manifest.icon)), true);
  assert.deepEqual(
    (manifest.screenshots || []).map((item) => item.path),
    [
      'media/gallery-01-hero.png',
      'media/gallery-02-status.png',
      'media/gallery-03-features.png'
    ]
  );
});

test('contributes Add and a Global overflow submenu on the Runlist view title', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const transfer = manifest.contributes.commands.find((item) => (
    item.command === 'runlist.transferProjects'
  ));
  const viewTitle = manifest.contributes.menus['view/title'];
  const overflow = (manifest.contributes.submenus || []).find((item) => (
    item.id === 'runlist.globalOverflow'
  ));
  const overflowItems = manifest.contributes.menus['runlist.globalOverflow'] || [];

  assert.deepEqual(transfer, {
    command: 'runlist.transferProjects',
    title: 'Import or Export',
    category: 'Runlist',
    icon: '$(files)'
  });
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.transferProjects'));
  assert.deepEqual(overflow, {
    id: 'runlist.globalOverflow',
    label: 'More Runlist actions',
    icon: '$(ellipsis)'
  });
  assert.ok(viewTitle.some((entry) => (
    entry.command === 'runlist.addProject'
      && entry.when === 'view == runlist.projects'
      && entry.group === 'navigation@1'
  )));
  assert.ok(viewTitle.some((entry) => (
    entry.submenu === 'runlist.globalOverflow'
      && entry.when === 'view == runlist.projects'
      && entry.group === 'navigation@2'
  )));
  assert.equal(
    viewTitle.some((entry) => entry.when && entry.when.includes('runlist.showTitlebarExtras')),
    false,
    'library actions must not stay gated behind showTitlebarExtras'
  );
  assert.deepEqual(
    overflowItems.map((item) => item.command),
    [
      'runlist.showAgentSetup',
      'runlist.transferProjects',
      'runlist.manageGroups',
      'runlist.showPortListening',
      'runlist.copySupportDiagnostics'
    ]
  );
});

test('view title commands use plain-language icon titles', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const byId = Object.fromEntries(
    manifest.contributes.commands.map((item) => [item.command, item.title])
  );

  assert.equal(byId['runlist.addProject'], 'Add Project');
  assert.equal(byId['runlist.showAgentSetup'], 'Set Up Agents');
  assert.equal(byId['runlist.transferProjects'], 'Import or Export');
  assert.equal(byId['runlist.manageGroups'], 'Manage Groups');
  assert.equal(byId['runlist.showPortListening'], "What's Listening");
  assert.equal(byId['runlist.importCompose'], 'Import Compose Services');
  assert.equal(byId['runlist.copySupportDiagnostics'], 'Copy Support Info');
});

test('contributes What\'s Listening through the Global overflow hub', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.showPortListening'));
  assert.ok((manifest.contributes.menus['runlist.globalOverflow'] || []).some((entry) => (
    entry.command === 'runlist.showPortListening'
  )));
  assert.equal(
    (manifest.contributes.menus['view/title'] || []).some((entry) => (
      entry.command === 'runlist.showPortListening'
    )),
    false,
    'What\'s Listening stays in the overflow submenu, not as its own titlebar icon'
  );
});

test('groups every contributed command under Runlist in the Command Palette', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = manifest.contributes.commands;

  assert.ok(commands.length > 0);
  assert.ok(commands.every((item) => item.category === 'Runlist'));
  assert.ok(commands.some((item) => item.command === 'runlist.addProject'));
});

test('contributes Start This Folder to the Command Palette without a sidebar title button', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = manifest.contributes.commands.find((item) => (
    item.command === 'runlist.startThisFolder'
  ));

  assert.deepEqual(command, {
    command: 'runlist.startThisFolder',
    title: 'Start This Folder',
    category: 'Runlist'
  });
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.startThisFolder'));
  assert.equal(
    (manifest.contributes.menus['view/title'] || []).some((item) => (
      item.command === 'runlist.startThisFolder'
    )),
    false
  );
  assert.equal(
    (manifest.contributes.menus.commandPalette || []).some((item) => (
      item.command === 'runlist.startThisFolder'
    )),
    false
  );
});

test('contributes local redacted support diagnostics', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = manifest.contributes.commands.find((item) => (
    item.command === 'runlist.copySupportDiagnostics'
  ));

  assert.deepEqual(command, {
    command: 'runlist.copySupportDiagnostics',
    title: 'Copy Support Info',
    category: 'Runlist'
  });
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.copySupportDiagnostics'));
  assert.ok((manifest.contributes.menus['runlist.globalOverflow'] || []).some((entry) => (
    entry.command === 'runlist.copySupportDiagnostics'
  )));
});
