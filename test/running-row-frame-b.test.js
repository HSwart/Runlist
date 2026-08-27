const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

test('running row keeps status and port on one second line', () => {
  assert.match(webview, /class="project-meta"/);
  assert.match(webview, /class="project-status status-\$\{rowStatusClass\}"/);
  assert.match(webview, /class="project-port-chip" data-action="open"/);
  assert.match(webview, /class="project-row-elapsed" data-row-elapsed/);
  assert.match(webview, /const rowPort = projectRowPort\(project\)/);
  assert.match(styles, /\.project-meta \{[\s\S]*flex-wrap: nowrap;/);
  assert.match(styles, /\.project-heading h2 \{[\s\S]*white-space: normal;/);
  assert.match(styles, /\.project-port-chip \{[\s\S]*font-size: 11px;/);
  assert.match(styles, /\.run-button \{[\s\S]*min-width: 24px;/);
  assert.match(styles, /\.project-actions \{[\s\S]*gap: 6px;/);
  assert.doesNotMatch(styles, /Inter|fonts\.googleapis|@font-face/);
  assert.doesNotMatch(webview, /class="project-services-summary"/);
  assert.match(styles, /\.project-status\.status-start-failed/);
  assert.match(styles, /\.project-status span \{[\s\S]*text-overflow: ellipsis;/);
});

test('running row shows Stop and Restart as row actions', () => {
  assert.match(
    webview,
    /class="run-button \$\{reviewRequired \? 'review' : blocked \? 'blocked' : primaryAction\.mode\}" data-action="\$\{primaryAction\.action\}"/
  );
  assert.match(
    webview,
    /\$\{canRestart \? `[\s\S]*class="run-button restart" data-action="restart" data-id="\$\{projectId\}" aria-label="Restart \$\{projectName\}"/
  );
  assert.match(webview, /title="Restart \$\{projectName\}" \$\{transitioning \? 'disabled' : ''\}/);
  assert.match(webview, /restart: \(\) => vscode\.postMessage\(\{ type: 'restartProject', id: button\.dataset\.id \}\)/);
  assert.match(webview, /data-action="restart" data-id="\$\{projectId\}" role="menuitem"/);
});

test('port chip opens the app at localhost through openProject', () => {
  assert.match(webview, /function projectRowPort\(project\)/);
  assert.match(webview, /project\.previewPort/);
  assert.match(
    webview,
    /aria-label="\$\{canOpen \? `Open \$\{projectName\} at \$\{escapeHtml\(project\.previewUrl \|\| `localhost\$\{portLabel\}`\)\}` : openTitle\}"/
  );
  assert.match(webview, /open: \(\) => \{[\s\S]*type: 'openProject'/);
  assert.match(
    webview,
    /class="preview-toggle" data-action="open-services" data-id="\$\{projectId\}" aria-expanded="\$\{project\.detailsExpanded\}"/
  );
  assert.doesNotMatch(webview, /\$\{projectListenerOwnerHtml\(project\)\}/);
  assert.doesNotMatch(webview, /who owns this port|data-action="kill-port"/i);
});
