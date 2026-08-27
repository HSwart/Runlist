const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const host = readShippedHostSource(root);

test('openable port chips look like links and say Open', () => {
  assert.match(webview, /class="project-port-chip\$\{canOpen \? ' is-openable' : ''\}"/);
  assert.match(webview, /project-open-label">Open/);
  assert.match(styles, /\.project-port-chip\.is-openable \{[\s\S]*--vscode-textLink-foreground/);
  assert.match(styles, /\.project-open-label \{[\s\S]*font-weight: 600/);
  assert.match(styles, /@media \(max-width: 300px\)[\s\S]*\.project-open-label \{[\s\S]*flex-shrink: 0/);
});

test('empty state is the workspace discovery surface', () => {
  assert.match(webview, /currentWorkspaceFolderName/);
  assert.match(webview, /Add \$\{workspaceFolderName \|\| 'the folder'\} open in this window\./);
  assert.match(webview, /class="empty-folder"/);
  assert.match(styles, /\.empty-folder \{/);
  assert.match(webview, /data-action="load-workspace-stack"/);
  assert.match(webview, /stackContractPending === true/);
  assert.match(webview, /'load-workspace-stack': \(\) => vscode\.postMessage\(\{ type: 'loadWorkspaceStack' \}\)/);
  assert.match(router, /loadWorkspaceStack: \(\) => host\.showProjectTransferLoadStack\(\)/);
  assert.match(host, /stackContractPendingForEmptyState\(\)/);
  assert.match(host, /stackContractPending: this\.stackContractPendingForEmptyState\(\)/);
  assert.match(host, /currentWorkspaceFolderName:/);
  assert.match(host, /Empty sidebar surfaces Load stack/);
  assert.match(host, /if \(this\.projects\.length === 0\) \{\s*return;/);
  assert.doesNotMatch(webview, /class="[^"]*workspace-strip/);
  assert.doesNotMatch(styles, /\.workspace-strip\b/);
});
