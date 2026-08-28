const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

test('filtered-to-zero empty block includes help text and Clear filters', () => {
  const emptyBlock = webview.slice(
    webview.indexOf('class="search-empty" data-search-empty hidden'),
    webview.indexOf('</section>`', webview.indexOf('class="search-empty" data-search-empty hidden'))
  );

  assert.match(emptyBlock, /<h2>No matching projects<\/h2>/);
  assert.match(emptyBlock, /<p>Try a different search or clear your filters\.<\/p>/);
  assert.match(
    emptyBlock,
    /<button type="button" class="primary-button" data-action="clear-filters" aria-label="Clear search, tag, and group filters">Clear filters<\/button>/
  );
  assert.doesNotMatch(emptyBlock, /<a[\s\S]*Clear filters/);
});

test('Clear filters reuses the revealRunningApp filter reset path', () => {
  assert.match(
    webview,
    /function clearProjectFilters\(\) \{[\s\S]*publishFilterState\('setSearchQuery'\)[\s\S]*applyProjectFilter\(''\)/
  );
  assert.match(webview, /'clear-filters': handleClearFilters/);
  assert.match(webview, /'clear-attention-filters': handleClearAttentionFilters/);
  assert.match(
    webview,
    /function handleClearAttentionFilters\(\) \{[\s\S]*clearProjectFilters\(\)[\s\S]*renderList\(\)[\s\S]*focusNextAttentionProject\(\)/
  );
  assert.match(
    webview,
    /function handleClearFilters\(\) \{[\s\S]*clearProjectFilters\(\)[\s\S]*renderList\(\)[\s\S]*project-search[\s\S]*No projects match\. Filters cleared\./
  );
  assert.match(
    webview,
    /function revealRunningApp\(id\) \{[\s\S]*if \(row\.hidden\) \{\s*clearProjectFilters\(\);\s*\}/
  );
  assert.doesNotMatch(
    webview.slice(
      webview.indexOf('function handleClearFilters'),
      webview.indexOf('function applyProjectFilter')
    ),
    /type: '(?:startProject|stopProject|restartProject|forceCloseProjectPorts)'/
  );
});

test('true zero-project empty state does not render search-empty or Clear filters', () => {
  const emptyState = webview.slice(
    webview.indexOf('if (state.projects.length === 0)'),
    webview.indexOf('const runningAppIds')
  );

  assert.match(emptyState, /class="empty-state"/);
  assert.match(emptyState, /<h2>No projects yet<\/h2>/);
  assert.doesNotMatch(emptyState, /data-search-empty/);
  assert.doesNotMatch(emptyState, /data-action="clear-filters"/);
  assert.doesNotMatch(emptyState, /No matching projects/);
});

test('search-empty stays usable at narrow width with theme variables', () => {
  assert.match(styles, /\.search-empty \{[\s\S]*overflow-x: hidden/);
  assert.match(styles, /\.search-empty p \{[\s\S]*overflow-wrap: anywhere/);
  assert.match(styles, /\.search-empty \.primary-button \{[\s\S]*max-width: 100%/);
  assert.match(
    styles,
    /@media \(max-width: 300px\) \{[\s\S]*\.search-empty \.primary-button \{[\s\S]*width: 100%/
  );
  assert.match(styles, /\.primary-button \{[\s\S]*--vscode-button-foreground[\s\S]*--vscode-button-background/);
});
