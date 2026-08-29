const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

test('review setup filter chip appears and filters review-required projects', () => {
  assert.match(webview, /function reviewFilterSummaryHtml\(projects\)/);
  assert.match(webview, /Review setup \(\$\{reviewCount\}\)/);
  assert.match(webview, /data-action="toggle-review-filter"/);
  assert.match(webview, /const matchesReview = !reviewFilterActive \|\| project\.reviewRequired === true/);
  assert.match(webview, /reviewFilterActive = persistedWebviewState\.reviewFilterActive === true/);
});

test('clearProjectFilters resets the review filter', () => {
  assert.match(
    webview,
    /function clearProjectFilters\(\) \{[\s\S]*reviewFilterActive = false/
  );
});

test('review filter chip uses summary attention styling', () => {
  assert.match(styles, /\.active-review-chip/);
});

test('review filter clears when no projects need review', () => {
  assert.match(
    webview,
    /if \(!reviewCount && reviewFilterActive\) \{[\s\S]*reviewFilterActive = false/
  );
});
