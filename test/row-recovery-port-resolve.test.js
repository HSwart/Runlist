const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  WEBVIEW_COMMAND_TYPES,
  validateWebviewCommand
} = require('../media/message-router');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const host = readShippedHostSource(root);

test('port resolve opens a sidebar overlay instead of Quick Pick', () => {
  assert.match(host, /this\.mode = 'port-resolve'/);
  assert.match(host, /async choosePortResolve\(action\)/);
  assert.match(host, /async buildPortResolve\(id, savedPort\)/);
  const resolveFn = host.match(/async resolveServicePort\([\s\S]*?\n  async buildPortResolve/);
  assert.ok(resolveFn, 'resolveServicePort should hand off to buildPortResolve');
  assert.doesNotMatch(resolveFn[0], /showQuickPick/);
  assert.match(resolveFn[0], /showPortListeningDiagnosis\(\{[\s\S]*focusPort: savedPort/);
  assert.match(webview, /function renderPortResolve\(/);
  assert.match(webview, /state\.mode === 'port-resolve'/);
  assert.match(webview, /data-action="choose-port-resolve"/);
  assert.match(webview, /type: 'choosePortResolve'/);
  assert.match(styles, /\.port-resolve-choice \{/);
  assert.match(router, /choosePortResolve: \(message\) => host\.choosePortResolve\(message\.action\)/);
  assert.ok(WEBVIEW_COMMAND_TYPES.has('choosePortResolve'));
  assert.ok(WEBVIEW_COMMAND_TYPES.has('loadWorkspaceStack'));
  assert.equal(
    validateWebviewCommand({ type: 'choosePortResolve', action: 'close' })?.action,
    'close'
  );
  assert.equal(validateWebviewCommand({ type: 'choosePortResolve', action: 'explode' }), undefined);
});

test('close path still uses confirmed modal recovery after overlay choice', () => {
  assert.match(host, /action === 'close'[\s\S]*forceCloseProjectPorts\(id, 'start', \{ servicePort: savedPort \}\)/);
  assert.match(host, /showWarningMessage\([\s\S]*modal: true/);
  assert.doesNotMatch(webview, /class="[^"]*attention-band/);
  assert.doesNotMatch(styles, /\.attention-band\b/);
});

test('summary offers a quiet Needs attention control that focuses a row', () => {
  assert.match(webview, /function projectNeedsAttention\(/);
  assert.match(webview, /function attentionSummaryHtml\(/);
  assert.match(webview, /id="summary-attention-slot"/);
  assert.match(webview, /class="summary-attention" data-action="focus-attention"/);
  assert.match(webview, /'focus-attention': \(\) => \{/);
  assert.match(webview, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(styles, /\.summary-attention-slot:empty \{[\s\S]*display: none/);
  assert.match(styles, /\.summary-attention \{[\s\S]*width: 100%/);
  assert.match(styles, /#project-count \{[\s\S]*white-space: nowrap/);
  assert.match(webview, /startFailureText \? escapeHtml\(startFailureText\)/);
  assert.doesNotMatch(webview, /summary-status"[\s\S]{0,200}Needs attention/);
  assert.doesNotMatch(webview, /class="[^"]*attention-section/);
  assert.doesNotMatch(styles, /\.attention-band\b/);
});
