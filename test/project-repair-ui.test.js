const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const router = fs.readFileSync(path.join(root, 'webview-message-router.js'), 'utf8');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

test('renders a complete accessible repair comparison and approval boundary', () => {
  assert.match(webview, /repair-comparison[^]*Current[^]*Proposed/);
  assert.match(webview, /repair-change[^]*\$\{escapeHtml\(item\.change\)\}/);
  assert.match(webview, /data-action="approve-repair"[^>]*>Approve complete proposal/);
  assert.match(webview, /data-action="reject-repair"[^>]*>Reject proposal/);
  assert.match(webview, /data-action="refresh-repair"/);
  assert.match(webview, /aria-live="polite"/);
});

test('keeps retry separate and routes it through the normal start gate', () => {
  assert.match(webview, /data-action="retry-repair"[^>]*>Retry start/);
  assert.match(router, /retryProjectRepair: \(\) => host\.retryProjectRepair\(\)/);
  assert.match(extension, /retryProjectRepair\(\)[\s\S]*this\.startProject\(projectId\)/);
  assert.doesNotMatch(extension, /approveProjectRepairProposal\([^)]*\)[\s\S]{0,300}startProject\(/);
});

test('reserves ownership before applying an approved proposal and ships the repair boundary to MCP', () => {
  assert.match(extension, /approveProjectRepair\(\)[\s\S]*processOwnership\.reserve\(project\.id\)/);
  assert.match(extension, /approveProjectRepairProposal\(this\.projectsFile, project\.id\)/);
  assert.match(extension, /installMcpBridge[\s\S]*project-repair\.js/);
});
