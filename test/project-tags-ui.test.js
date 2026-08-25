const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const extension = readShippedHostSource(root);
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

test('keeps project tags in one accessible on-demand filter instead of cards', () => {
  assert.match(webview, /class="project-tag-filter" aria-label="Project tag filter"/);
  assert.match(webview, /data-action="toggle-tag-filter" aria-expanded=/);
  assert.match(webview, /role="group" aria-label="Filter projects by tag"/);
  assert.match(webview, /data-action="select-tag-filter"[^>]*aria-pressed=/);
  assert.doesNotMatch(webview, /class="project-tags"/);
  assert.match(styles, /\.project-tag-choices[\s\S]*flex-wrap: wrap/);
  assert.match(styles, /overflow-x: hidden/);
});

test('combines text search and the selected tag and announces the result', () => {
  assert.match(webview, /matchesQuery && matchesTag/);
  assert.match(webview, /filtered by \$\{selectedTagFilter\}/);
  assert.match(webview, /event\.key === 'Escape' && tagsExpanded/);
});

test('publishes the current tag vocabulary from render state', () => {
  assert.match(
    extension,
    /render\(\) \{[\s\S]*const projects = this\.projects;[\s\S]*const tags = projectTagVocabulary\(projects\);[\s\S]*const state = \{[\s\S]*tags,/
  );
  assert.doesNotMatch(
    extension,
    /forceCloseProjectPorts[\s\S]{0,300}projectTagVocabulary/
  );
});
