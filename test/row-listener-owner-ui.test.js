const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const host = fs.readFileSync(path.join(root, 'src', 'host', 'runlist-view-provider.js'), 'utf8');
const statusDisplay = fs.readFileSync(path.join(root, 'media', 'project-status-display.js'), 'utf8');

test('row keeps listener owner off the everyday list line', () => {
  assert.doesNotMatch(webview, /\$\{projectListenerOwnerHtml\(project\)\}/);
  assert.doesNotMatch(webview, /class="project-services-summary"/);
  assert.doesNotMatch(webview, /data-action="kill-port"|who owns this port/i);
  assert.doesNotMatch(styles, /Inter|fonts\.googleapis|@font-face/);
});

test('other Runlist owner switches via existing reveal flow; external close stays off the row', () => {
  assert.match(
    webview,
    /data-action="reveal-listening-project" data-id="\$\{escapeHtml\(String\(owner\.revealProjectId\)\)\}"/
  );
  assert.match(webview, /type: 'revealPortOwnerProject'/);
  assert.match(webview, /data-action="force-close-ports" data-id="\$\{projectId\}" role="menuitem"/);
  assert.match(webview, /data-action="resolve-service-port"/);
  assert.doesNotMatch(
    webview,
    /class="project-listener-owner"[^>]*data-action="force-close-ports/
  );
});

test('host publishes listenerOwner and announcements include owner class', () => {
  assert.match(host, /buildProjectListenerOwners/);
  assert.match(host, /listenerOwner: this\.projectListenerOwners\.get\(project\.id\)/);
  assert.match(host, /findListeningProcesses\(listenerPorts\)/);
  assert.match(statusDisplay, /project\.listenerOwner\?\.announcement/);
});
