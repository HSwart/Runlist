const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WEBVIEW_DEBUG_ENDPOINT_TIMEOUT_MS,
  WEBVIEW_FRAME_TIMEOUT_MS,
  WEBVIEW_HOST_COMPLETION_TIMEOUT_MS
} = require('../scripts/webview-e2e-timeouts');

test('keeps the extension host alive beyond cold browser and webview discovery', () => {
  assert.ok(WEBVIEW_FRAME_TIMEOUT_MS >= 90000);
  assert.ok(
    WEBVIEW_HOST_COMPLETION_TIMEOUT_MS
      > WEBVIEW_DEBUG_ENDPOINT_TIMEOUT_MS + WEBVIEW_FRAME_TIMEOUT_MS
  );
});
