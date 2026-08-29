const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

test('copy error is exposed in the row More menu and host router', () => {
  const host = readShippedHostSource();
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const router = fs.readFileSync(path.join(__dirname, '..', 'media', 'message-router.js'), 'utf8');
  const webviewRouter = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webview-message-router.js'), 'utf8');

  assert.match(webview, /data-action="copy-error"/);
  assert.match(webview, /Copy error/);
  assert.match(webview, /type: 'copyProjectFailure'/);
  assert.match(router, /'copyProjectFailure'/);
  assert.match(webviewRouter, /copyProjectFailure: \(message\) => host\.copyProjectFailure\(message\.id\)/);
  assert.match(host, /async copyProjectFailure\(id\)/);
  assert.match(host, /buildStartFailureClipboardText/);
  assert.match(host, /buildStopFailureClipboardText/);
  assert.doesNotMatch(host, /async copyProjectFailure[\s\S]{0,1200}(?:fetch\(|openExternal|spawn\()/);
});
