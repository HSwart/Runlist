const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const extension = readShippedHostSource(root);
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');

test('What\'s listening screen stays read-only and routes into existing close flow', () => {
  assert.match(webview, /function renderPortListening\(/);
  assert.match(webview, /What's listening/);
  assert.match(webview, /data-action="refresh-port-listening"/);
  assert.match(webview, /data-action="copy-port-listening"/);
  assert.match(webview, /data-action="reveal-listening-project"/);
  assert.match(webview, /Close listener…/);
  assert.doesNotMatch(webview, /auto-kill|bulk kill|kill all/i);
  assert.match(webview, /port-listening-row\$\{port === Number\(report\.focusPort\) \? ' is-focused' : ''\}/);
  assert.match(styles, /\.port-listening-row \{/);
  assert.match(styles, /\.port-listening-row\.is-focused \{/);
  assert.match(extension, /async showPortListeningDiagnosis\(/);
  assert.match(extension, /portListeningFocusPort/);
  assert.match(extension, /async refreshPortListeningDiagnosis\(/);
  assert.match(extension, /buildPortListeningReport\(/);
  assert.match(extension, /forceCloseProjectPorts\(/);
  assert.match(router, /showPortListening: \(\) => host\.showPortListeningDiagnosis\(\)/);
  assert.match(router, /revealPortOwnerProject: \(message\) => host\.revealPortOwnerProject\(message\.id\)/);
  assert.match(router, /servicePort: port/);
});
