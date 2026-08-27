const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const host = readShippedHostSource(root);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Agents opens from Global overflow only — never a list band', () => {
  const overflowItems = manifest.contributes.menus['runlist.globalOverflow'] || [];
  assert.ok(overflowItems.some((entry) => entry.command === 'runlist.showAgentSetup'));
  assert.equal(
    (manifest.contributes.menus['view/title'] || []).some((entry) => (
      entry.command === 'runlist.showAgentSetup'
    )),
    false
  );
  assert.match(host, /async showAgentSetup\(/);
  assert.match(webview, /function renderAgentSetup\(/);
  assert.match(webview, /class="agent-screen"/);
  assert.match(webview, /class="agent-list" aria-label="Supported coding agents"/);
  assert.doesNotMatch(webview, /class="[^"]*agents-(?:section|strip|band)/);
  assert.doesNotMatch(webview, /<section[^>]*>\s*<h2>\s*Agents\s*<\/h2>/);
  const emptyStart = webview.indexOf('if (state.projects.length === 0)');
  const emptyEnd = webview.indexOf('const runningAppIds', emptyStart);
  const emptyState = webview.slice(emptyStart, emptyEnd);
  assert.doesNotMatch(emptyState, /show-agent|Agent connections|Set up Agents/i);
});

test('agent connection cards stack at narrow sidebar width', () => {
  assert.match(styles, /\.agent-list \{[\s\S]*display:\s*grid/);
  assert.match(
    styles,
    /@media \(max-width: 300px\) \{[\s\S]*\.agent-card-heading \{[\s\S]*flex-direction:\s*column/
  );
  assert.match(
    styles,
    /@media \(max-width: 300px\) \{[\s\S]*\.agent-register-button \{[\s\S]*width:\s*100%/
  );
});

test('agent registration does not change the reviewRequired approve boundary', () => {
  assert.match(host, /async registerAgent\(/);
  assert.doesNotMatch(host, /registerAgent\([\s\S]{0,400}reviewRequired:\s*false/);
});
