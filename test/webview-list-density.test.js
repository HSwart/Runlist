const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const host = fs.readFileSync(path.join(root, 'src', 'host', 'runlist-view-provider.js'), 'utf8');

test('keeps the everyday list to name, status, primary action, and overflow', () => {
  assert.match(webview, /class="project-meta"/);
  assert.match(webview, /class="project-status status-\$\{statusClass\}"/);
  assert.match(webview, /class="run-button /);
  assert.match(webview, /aria-label="More actions for \$\{projectName\}"/);
  assert.match(webview, /class="visually-hidden">\$\{escapeHtml\(project\.folder\)\}/);
  assert.doesNotMatch(webview, /class="detail-row"/);
  assert.doesNotMatch(webview, /Services · \$\{project\.services\.length\}/);
  assert.match(webview, /services\.slice\(0, 3\)\.map\(\(service\) => `\$\{service\.name\} :\$\{service\.port\}`\)/);
});

test('does not explain the product on first-run or everyday screens', () => {
  assert.match(webview, /<h2>No projects yet<\/h2>/);
  assert.match(webview, /data-action="show-add">\$\{addLabel\}/);
  assert.match(webview, /Add this folder/);
  assert.match(webview, /Save a start command for the folder open in this window/);
  assert.match(webview, /Save a project folder and its start command once/);
  assert.doesNotMatch(webview, /Save a project folder and its commands once/);
  assert.doesNotMatch(webview, /Choose a folder and save its commands and services once/);
  assert.doesNotMatch(webview, /Update \$\{escapeHtml\(state\.draft\.name/);
  assert.doesNotMatch(webview, /Connect Runlist and add its guided project setup skill/);
  assert.doesNotMatch(webview, /Start and Stop control the project process that owns this service/);
  assert.doesNotMatch(host, /Owned group processes stopped/);
  assert.doesNotMatch(host, /All group projects are ready/);
});

test('uses compact native sidebar density instead of padded cards', () => {
  assert.match(styles, /\.project-row \{[\s\S]*padding: 5px 12px 6px;/);
  assert.match(styles, /\.project-status \{[\s\S]*background: transparent;/);
  assert.match(styles, /\.project-services-summary \{[\s\S]*border: 0;/);
  assert.match(styles, /\.run-button \{[\s\S]*width: 22px;[\s\S]*height: 22px;/);
  assert.match(styles, /\.empty-state \{[\s\S]*padding: 16px 12px;/);
  assert.doesNotMatch(styles, /border-radius: 10px;/);
});
