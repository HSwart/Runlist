const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('webview E2E waits for a visible view before releasing the browser', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'smoke', 'webview-e2e-host.js'),
    'utf8'
  );
  const showIndex = source.indexOf('api.provider.view.show(false)');
  const visibleIndex = source.indexOf("api.provider.view?.visible === true");
  const readyIndex = source.indexOf("path.join(root, 'host-ready.json')");

  assert.ok(showIndex >= 0, 'the harness should explicitly reveal the resolved view');
  assert.ok(visibleIndex > showIndex, 'the harness should wait for visibility after revealing');
  assert.ok(readyIndex > visibleIndex, 'browser readiness must follow visible view readiness');
});
