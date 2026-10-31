const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function readText(...relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const webview = readText('media', 'main.js');
const styles = readText('media', 'styles.css');
const host = readText('src', 'host', 'runlist-view-provider.js');

test('keeps the everyday list to two lines: wrapping name, then status and port', () => {
  assert.match(webview, /class="project-meta"/);
  assert.match(webview, /class="project-status status-\$\{rowStatusClass\}"/);
  assert.match(webview, /class="project-port-chip\$\{canOpen \? ' is-openable' : ''\}" data-action="open"/);
  assert.match(webview, /class="run-button /);
  assert.match(webview, /aria-label="More actions for \$\{projectName\}"/);
  assert.match(webview, /class="visually-hidden">\$\{escapeHtml\(project\.folder\)\}/);
  assert.doesNotMatch(webview, /class="detail-row"/);
  assert.doesNotMatch(webview, /Services · \$\{project\.services\.length\}/);
  assert.doesNotMatch(webview, /class="project-services-summary"/);
  assert.doesNotMatch(webview, /class="auto-scroll"><span class="auto-scroll-content">\$\{projectName\}/);
  assert.doesNotMatch(webview, /readinessDetailsHtml\(project, projectStatus\)/);
  assert.doesNotMatch(webview, /class="current-window-label">This window</);
});

test('does not explain the product on first-run or everyday screens', () => {
  assert.match(webview, /<h2>\$\{stackHeroCopy \? 'Load team stack' : 'No projects yet'\}<\/h2>/);
  assert.match(webview, /Add this folder/);
  assert.match(webview, /Add \$\{workspaceFolderName \|\| 'the folder'\} open in this window\./);
  assert.match(webview, /Open a folder in this window first\./);
  assert.doesNotMatch(webview, /Save a start command for the folder open in this window/);
  assert.doesNotMatch(webview, /Save a project folder and its start command once/);
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
  assert.match(styles, /\.project-port-chip \{[\s\S]*border: 0;/);
  assert.match(styles, /\.run-button \{[\s\S]*width: 22px;[\s\S]*height: 22px;/);
  assert.match(styles, /\.empty-state \{[\s\S]*padding: 16px 12px;/);
  assert.match(styles, /\.project-heading h2 \{[\s\S]*white-space: normal;/);
  assert.match(styles, /\.project-meta \{[\s\S]*flex-wrap: nowrap;/);
  assert.match(styles, /\.current-window-label \{[\s\S]*display: none;/);
  assert.doesNotMatch(styles, /border-radius: 10px;/);
});

test('uses VS Code theme fonts for sidebar chrome and leaves output on the editor font', () => {
  assert.doesNotMatch(styles, /@font-face/);
  assert.match(styles, /^:root \{[\s\S]*?font-family: var\(--vscode-font-family\), system-ui, sans-serif;/m);
  assert.match(styles, /\.project-search input \{[\s\S]*?font-family: inherit;/);
  assert.match(styles, /\.output-peek-line \{\n(?:  .*\n)*  font-family: var\(--vscode-editor-font-family\);\n  font-size: var\(--vscode-editor-font-size, 11px\);/);
  assert.match(styles, /\.output-entry \{\n(?:  .*\n)*  font-family: var\(--vscode-editor-font-family\);\n  font-size: var\(--vscode-editor-font-size, 11px\);/);
  assert.doesNotMatch(styles, /fonts\.googleapis/);
});

test('hides project search on a one-row list', () => {
  assert.match(webview, /\$\{state\.projects\.length > 1 \? `/);
  assert.match(webview, /id="project-search"/);
});
