const path = require('node:path');

function resolveWebviewArtifactDir(root) {
  const configured = process.env.RUNLIST_WEBVIEW_ARTIFACT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(root, 'artifacts', 'screenshots');
}

module.exports = { resolveWebviewArtifactDir };
