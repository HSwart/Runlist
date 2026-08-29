const assert = require('node:assert/strict');
const test = require('node:test');
const { stopGroupConfirmation } = require('../src/lifecycle/project-lifecycle');
const { readShippedHostSource } = require('./helpers/extension-source');
const fs = require('node:fs');
const path = require('node:path');

test('stop-group confirmation names skipped members and external listeners', () => {
  const confirmation = stopGroupConfirmation({
    groupName: 'Stack',
    stoppableCount: 2,
    projectNames: ['API', 'Web']
  });
  assert.equal(confirmation.message, 'Stop group Stack?');
  assert.equal(confirmation.confirmLabel, 'Stop group');
  assert.match(confirmation.detail, /2 running projects/);
  assert.match(confirmation.detail, /already stopped, running elsewhere/);
  assert.match(confirmation.detail, /External listeners are not closed/);
  assert.match(confirmation.detail, /API/);
  assert.match(confirmation.detail, /Web/);
});

test('stop-group confirmation bounds long project name lists', () => {
  const confirmation = stopGroupConfirmation({
    groupName: 'Big stack',
    stoppableCount: 10,
    projectNames: Array.from({ length: 10 }, (_, index) => `Project ${index + 1}`)
  });
  assert.match(confirmation.detail, /Project 1/);
  assert.match(confirmation.detail, /Project 8/);
  assert.doesNotMatch(confirmation.detail, /Project 9/);
  assert.match(confirmation.detail, /…and 2 more/);
});

test('wires Stop group through a modal before lifecycle.stopGroup runs', () => {
  const host = readShippedHostSource();
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(host, /async stopSavedRunGroup\(id\)/);
  assert.match(host, /stopGroupConfirmation\(/);
  assert.match(host, /showWarningMessage\([\s\S]*\{ modal: true, detail: confirmation\.detail \}/);
  assert.match(host, /choice !== confirmation\.confirmLabel[\s\S]*action: 'stop-group'/);
  assert.match(host, /this\.lifecycle\.stopGroup\(id\)/);
  assert.match(webview, /'stop-group': \(\) => vscode\.postMessage\(\{ type: 'stopRunGroup'/);
});
