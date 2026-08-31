const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveWebviewArtifactDir } = require('../scripts/webview-e2e-artifacts');

function restoreWebviewArtifactDir(previous) {
  if (previous === undefined) {
    delete process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR;
    return;
  }
  process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR = previous;
}

test('defaults webview artifact output to the temporary E2E root', (t) => {
  const previous = process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR;
  t.after(() => {
    restoreWebviewArtifactDir(previous);
  });
  delete process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR;

  const root = path.join(os.tmpdir(), 'runlist-e2e-fixture');
  assert.equal(
    resolveWebviewArtifactDir(root),
    path.join(root, 'artifacts', 'screenshots')
  );
});

test('honors RUNLIST_WEBVIEW_ARTIFACT_DIR when set', (t) => {
  const previous = process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR;
  const root = path.join(os.tmpdir(), 'runlist-e2e-fixture');
  const customDir = path.join(os.tmpdir(), 'custom-webview-artifacts');
  t.after(() => {
    restoreWebviewArtifactDir(previous);
  });
  process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR = customDir;
  assert.equal(resolveWebviewArtifactDir(root), customDir);
});
