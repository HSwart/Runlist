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
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { validateWebviewCommand } = require('../media/message-router');

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
  const messageRouter = fs.readFileSync(path.join(root, 'media', 'message-router.js'), 'utf8');
  assert.match(messageRouter, /'loadWorkspaceStack'/);
  assert.match(host, /stackContractPending: this\.projects\.length === 0/);
  assert.match(host, /Boolean\(this\.stackContractSummary\(\)\?\.pending\)/);
  assert.match(host, /currentWorkspaceFolderName:/);
  assert.doesNotMatch(host, /showInformationMessage\(\s*'This workspace has a Runlist stack file/);
  assert.doesNotMatch(webview, /class="[^"]*workspace-strip/);
  assert.doesNotMatch(styles, /\.workspace-strip\b/);
  assert.match(styles, /\.empty-actions \{[\s\S]*flex-wrap: wrap/);
});

test('Load stack opens a sidebar stack-review overlay instead of Quick Pick confirm', () => {
  assert.match(host, /this\.mode = 'stack-review'/);
  assert.match(host, /async approveStackReview\(/);
  assert.match(host, /prepareStackContractLoad\(/);
  assert.match(host, /commitStackContractLoad\(/);
  assert.doesNotMatch(host, /runStackContractLoadWorkflow\(/);
  assert.match(webview, /function renderStackReview\(/);
  assert.match(webview, /state\.mode === 'stack-review'/);
  assert.match(webview, /data-action="approve-stack-review"/);
  assert.match(router, /approveStackReview: \(\) => host\.approveStackReview\(\)/);
  assert.equal(validateWebviewCommand({ type: 'approveStackReview' })?.type, 'approveStackReview');
  assert.ok(manifest.activationEvents.includes('onCommand:runlist.loadWorkspaceStack'));
  assert.ok((manifest.contributes.menus['runlist.globalOverflow'] || []).some((entry) => (
    entry.command === 'runlist.loadWorkspaceStack'
  )));
});

test('multi-root workspace folders are chosen in the sidebar, not Quick Pick', () => {
  assert.match(webview, /data-action="select-workspace-folder"/);
  assert.match(webview, /empty-workspace-choices/);
  assert.match(router, /selectWorkspaceFolder: \(message\) => host\.selectPreferredWorkspaceFolder\(message\.folder, message\.draft\)/);
  assert.match(host, /async selectPreferredWorkspaceFolder\(/);
  assert.match(host, /workspaceFolders: workspaceFolderChoices\(/);
  assert.equal(validateWebviewCommand({
    type: 'selectWorkspaceFolder',
    folder: '/tmp/app'
  })?.folder, '/tmp/app');
  assert.equal(validateWebviewCommand({ type: 'selectWorkspaceFolder', folder: '' }), undefined);
});
