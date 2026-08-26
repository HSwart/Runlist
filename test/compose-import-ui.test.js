const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const host = readShippedHostSource(root);
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const messageRouter = fs.readFileSync(path.join(root, 'media', 'message-router.js'), 'utf8');

test('Compose import review is read-only until save and never runs docker compose', () => {
  assert.match(webview, /function renderComposeImport\(/);
  assert.match(webview, /Review Compose import/);
  assert.match(webview, /data-action="approve-compose-import"/);
  assert.match(webview, /data-action="import-compose"/);
  assert.match(webview, /Runlist has not started Docker or Compose/);
  assert.match(styles, /\.compose-import-row \{/);
  assert.match(host, /async showComposeImport\(/);
  assert.match(host, /async approveComposeImport\(/);
  assert.match(host, /buildComposeImportProposal\(/);
  assert.doesNotMatch(host, /spawn\(.*docker|execFile\(.*docker|docker compose up/);
  assert.match(router, /showComposeImport: \(message\) => host\.showComposeImport\(message\.id\)/);
  assert.match(router, /approveComposeImport: \(\) => host\.approveComposeImport\(\)/);
  assert.match(messageRouter, /'showComposeImport'/);
  assert.match(messageRouter, /'approveComposeImport'/);
});
