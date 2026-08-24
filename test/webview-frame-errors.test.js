const assert = require('node:assert/strict');
const test = require('node:test');
const { webviewFrameWasReplaced } = require('../scripts/webview-frame-errors');

test('recognizes Chromium errors caused by a replaced VS Code webview frame', () => {
  for (const message of [
    'locator.click: Frame was detached',
    'Protocol error (DOM.scrollIntoViewIfNeeded): Cannot find context with specified id',
    'Execution context was destroyed, most likely because of a navigation'
  ]) {
    assert.equal(webviewFrameWasReplaced(new Error(message)), true, message);
  }
});

test('does not hide genuine webview interaction failures', () => {
  for (const message of [
    'locator.click: Timeout 5000ms exceeded',
    'Element is not enabled',
    'Target page, context or browser has been closed'
  ]) {
    assert.equal(webviewFrameWasReplaced(new Error(message)), false, message);
  }
});
