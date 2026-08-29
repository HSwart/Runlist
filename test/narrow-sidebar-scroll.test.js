const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

test('project row status uses auto-scroll instead of ellipsis truncation', () => {
  assert.match(webview, /function autoScrollHtml\(text\)/);
  assert.match(
    webview,
    /class="project-status status-\$\{rowStatusClass\}"[\s\S]*autoScrollHtml\(`<span>\$\{escapeHtml\(displayedStatus\)\}<\/span>`\)/
  );
  assert.match(styles, /\.project-status \.auto-scroll \{[\s\S]*min-width: 0;/);
  assert.doesNotMatch(styles, /\.project-status span \{[\s\S]*text-overflow: ellipsis;/);
  assert.doesNotMatch(styles, /@media \(max-width: 300px\) \{[\s\S]*\.project-status span \{[\s\S]*text-overflow: ellipsis;/);
});

test('readiness row text keeps full detail in the status title', () => {
  assert.match(webview, /const readinessRowText = projectRowReadinessStatusText\(project\)/);
  assert.match(webview, /readinessRowText \? escapeHtml\(projectStatusDetailText\(project\)\) : ''/);
});

test('Needs attention control scrolls overflowing labels', () => {
  assert.match(webview, /class="summary-attention"[\s\S]*autoScrollHtml\(escapeHtml\(label\)\)/);
  assert.match(styles, /\.summary-attention \.auto-scroll \{[\s\S]*min-width: 0;/);
});

test('preview-unavailable fallback hides label text at narrow width', () => {
  assert.match(webview, /class="preview-fallback-open"[\s\S]*autoScrollHtml\('<span>Open in browser<\/span>'\)/);
  assert.match(styles, /@media \(max-width: 300px\) \{[\s\S]*\.preview-fallback-open \.auto-scroll \{[\s\S]*display: none;/);
});

test('reuses existing auto-scroll measurement after list render', () => {
  assert.match(webview, /function updateAutoScroll\(\)/);
  assert.match(webview, /function scheduleAutoScrollUpdate\(\)/);
  assert.match(webview, /scheduleAutoScrollUpdate\(\);[\s\S]*initializeProjectPreview\(\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.auto-scroll\.is-overflowing/);
});
