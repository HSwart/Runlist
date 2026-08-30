const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

test('start creates a named run terminal and mirrors captured output', () => {
  const source = readShippedHostSource(path.join(__dirname, '..'));
  assert.match(source, /ensureRunlistTerminal\(id, launchProject, launchEnvironment\)/);
  assert.match(source, /runlistTerminalName\(project\.name\)/);
  assert.match(source, /writeProjectTerminal\(id, chunk\)/);
});

test('showProjectTerminal focuses the run terminal with folder fallback', () => {
  const source = readShippedHostSource(path.join(__dirname, '..'));
  assert.match(source, /async showProjectTerminal\(id\)/);
  assert.match(source, /this\.projectRunTerminals\.get\(id\)/);
  assert.match(source, /openProjectTerminal\(vscode, project\.folder\)/);
});

test('webview wires show-terminal to the host handler', () => {
  const root = path.join(__dirname, '..');
  const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  assert.match(router, /showTerminal: \(message\) => host\.showProjectTerminal\(message\.id\)/);
  assert.match(webview, /'show-terminal': \(\) => \{[\s\S]*type: 'showTerminal'/);
  assert.match(webview, /data-action="show-terminal"/);
});
