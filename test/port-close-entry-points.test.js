const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const host = readShippedHostSource(root);
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const recovery = fs.readFileSync(path.join(root, 'src', 'ports', 'port-recovery.js'), 'utf8');

test('diagnosis Close listener and run-row close share recoverProjectPorts confirm+revalidate', () => {
  assert.match(
    webview,
    /data-action="force-close-ports" data-id="\$\{escapeHtml\(row\.closeProjectId\)\}" data-port="\$\{port\}"/
  );
  assert.match(
    webview,
    /data-action="force-close-ports" data-id="\$\{projectId\}" role="menuitem"/
  );
  assert.match(webview, /'force-close-ports-and-start': \(\) => \{/);
  assert.match(
    webview,
    /data-action="force-close-ports-and-start" data-id="\$\{projectId\}" role="menuitem"/
  );
  assert.match(router, /forceCloseProjectPorts: \(message\) => \{/);
  assert.match(router, /servicePort: port/);
  assert.match(router, /forceCloseProjectPortsAndStart: \(message\) => host\.forceCloseProjectPorts\(message\.id, 'start'\)/);

  assert.match(host, /const result = await recoverProjectPorts\(recoveryProject, intent/);
  assert.match(host, /confirmPortClosure: async \(\{ openPorts, processes \}\) => \{/);
  assert.match(host, /portClosureConfirmation\(recoveryProject, intent, openPorts, processes\)/);
  assert.match(host, /showWarningMessage\(\s*confirmation\.message/);
  assert.match(host, /modal: true/);
  assert.match(host, /portCloseUserMessage\(project\.name, result, intent\)/);

  assert.match(recovery, /currentListeners\.some/);
  assert.match(recovery, /status: 'changed'/);
  assert.match(recovery, /await options\.confirmPortClosure\(/);
  assert.match(recovery, /await options\.terminateListenerProcess\(/);
});

test('close path never adds a diagnosis-only or row-only kill shortcut', () => {
  assert.doesNotMatch(webview, /data-action="kill-listener"|data-action="kill-port"/i);
  assert.doesNotMatch(router, /terminateListenerProcess/);
  assert.doesNotMatch(
    host,
    /if \(this\.mode === 'port-listening'\)[\s\S]{0,400}terminateListenerProcess\(/
  );
});
