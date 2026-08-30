const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveWebviewArtifactDir } = require('../scripts/webview-e2e-artifacts');

test('defaults webview artifact output to the temporary E2E root', () => {
  const root = path.join(os.tmpdir(), 'runlist-e2e-fixture');
  assert.equal(
    resolveWebviewArtifactDir(root),
    path.join(root, 'artifacts', 'screenshots')
  );
});

test('honors RUNLIST_WEBVIEW_ARTIFACT_DIR when set', (t) => {
  const root = path.join(os.tmpdir(), 'runlist-e2e-fixture');
  const customDir = path.join(os.tmpdir(), 'custom-webview-artifacts');
  t.after(() => {
    delete process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR;
  });
  process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR = customDir;
  assert.equal(resolveWebviewArtifactDir(root), customDir);
});
