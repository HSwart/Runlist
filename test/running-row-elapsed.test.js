const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

test('running row shows timeline elapsed on line 2 with status and port', () => {
  assert.match(webview, /function projectRowElapsedStartedAt\(project = \{\}\)/);
  assert.match(webview, /project\.timeline\?\.launchedAt/);
  assert.match(
    webview,
    /\['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active'\]\.includes\(status\)/
  );
  assert.match(
    webview,
    /class="project-row-elapsed" data-row-elapsed data-started-at="\$\{rowElapsedStartedAt\}"/
  );
  assert.match(webview, /aria-label="Running for \$\{escapeHtml\(rowElapsedLabel\)\}"/);
  assert.match(styles, /\.project-row-elapsed \{[\s\S]*font-size: 11px;/);
  assert.match(styles, /\.project-meta \{[\s\S]*flex-wrap: nowrap;/);
  assert.doesNotMatch(styles, /fonts\.googleapis/);
});

test('row elapsed reuses the existing timeline clock and skips stopped rows', () => {
  assert.match(webview, /document\.querySelectorAll\('\[data-row-elapsed\]'\)/);
  assert.match(
    webview,
    /const elapsed = document\.querySelector\('\[data-timeline-elapsed\], \[data-row-elapsed\]'\)/
  );
  assert.match(
    webview,
    /document\.querySelector\('\[data-timeline-elapsed\]\[data-ready-at=""\], \[data-row-elapsed\]'\)/
  );
  assert.match(webview, /element\.setAttribute\('aria-label', `Running for \$\{label\}`\)/);
  assert.doesNotMatch(webview, /new clock|settings toggle|showElapsed/i);
});
