const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('ships as a local UI extension with a Marketplace icon', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.deepEqual(manifest.extensionKind, ['ui', 'workspace']);
  assert.equal(manifest.icon, 'media/runlist.png');
  assert.equal(fs.existsSync(path.join(root, manifest.icon)), true);
});

test('contributes one native project transfer command to the Runlist view', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = manifest.contributes.commands.find((item) => (
    item.command === 'runlist.transferProjects'
  ));
  const menu = manifest.contributes.menus['view/title'].find((item) => (
    item.command === 'runlist.transferProjects'
  ));

  assert.deepEqual(command, {
    command: 'runlist.transferProjects',
    title: 'Import or Export Projects',
    icon: '$(files)'
  });
  assert.deepEqual(menu, {
    command: 'runlist.transferProjects',
    when: 'view == runlist.projects',
    group: 'navigation@3'
  });
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.transferProjects'));
});

test('contributes local redacted support diagnostics', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = manifest.contributes.commands.find((item) => (
    item.command === 'runlist.copySupportDiagnostics'
  ));

  assert.deepEqual(command, {
    command: 'runlist.copySupportDiagnostics',
    title: 'Copy Runlist Support Diagnostics'
  });
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.copySupportDiagnostics'));
  assert.deepEqual(manifest.contributes.configuration.properties['runlist.diagnostics.trace'], {
    type: 'boolean',
    default: false,
    description: 'Include bounded, redacted error details in the local Runlist output and copied support diagnostics.'
  });
});
