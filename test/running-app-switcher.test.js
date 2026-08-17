const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('renders one accessible running-app navigator only for overflowing running projects', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(extension, /runningAppIds: runningAppProjectIds\(stateProjects\)/);
  assert.match(webview, /runningApps\.length > 1/);
  assert.match(webview, /<nav class="running-app-navigator" data-running-app-navigator aria-label="Running app navigator" hidden>/);
  assert.match(webview, /data-action="previous-running-app" aria-label="Previous running app"/);
  assert.match(webview, /data-action="next-running-app" aria-label="Next running app"/);
  assert.match(webview, /const navigatorBounds = navigator\.getBoundingClientRect\(\);/);
  assert.match(webview, /const navigatorOffset = !navigator\.hidden && navigatorBounds\.top <= 0[\s\S]*\? navigator\.offsetHeight[\s\S]*: 0/);
  assert.match(webview, /bounds\.bottom - navigatorOffset <= window\.innerHeight/);
  assert.match(webview, /navigator\.hidden = allFit;[\s\S]*if \(allFit\)[\s\S]*return/);
  assert.doesNotMatch(webview, /running-app-select/);
  assert.match(styles, /\.running-app-navigator[\s\S]*position: sticky/);
  assert.match(styles, /\.running-app-bar[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /\.running-app-current[\s\S]*min-width: 0/);
});

test('loads one safe thumbnail only while the overflow navigator is visible', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /previewFrameSources\(\[[\s\S]*expandedPreview\?\.previewUrl[\s\S]*runningAppIdSet/);
  assert.match(webview, /data-running-app-frame[^>]*aria-hidden="true"[^>]*tabindex="-1"[^>]*sandbox="allow-forms allow-scripts allow-same-origin"[^>]*referrerpolicy="no-referrer"[^>]*loading="lazy"/);
  assert.match(webview, /navigator\.hidden = allFit;[\s\S]*if \(allFit\) \{[\s\S]*unloadRunningAppThumbnail\(navigator\)/);
  assert.match(webview, /function updateRunningAppThumbnail\(navigator, project\)[\s\S]*const url = project\.previewUrl[\s\S]*frame\.src = url/);
  assert.match(webview, /if \(!url\) \{[\s\S]*unloadRunningAppThumbnail\(navigator\)/);
});

test('opens a thumbnail through explicit and double-click actions without changing runtime', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(webview, /class="running-app-open" data-action="open"[^>]*aria-label="Open running app in browser"/);
  assert.match(webview, /app\.addEventListener\('dblclick',[\s\S]*\.running-app-thumbnail-target\[data-id\][\s\S]*type: 'openProject'/);
  assert.match(webview, /thumbnailTarget\.dataset\.canOpen = String\(Boolean\(current\.project\.previewUrl\)\)/);
  assert.match(webview, /target\?\.dataset\.canOpen === 'true'/);
});

test('reveals and focuses a selected running project without changing its runtime', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(webview, /function revealRunningApp\(id\)/);
  assert.match(webview, /if \(row\.hidden\)[\s\S]*setSearchQuery[\s\S]*applyProjectFilter\(''\)/);
  assert.match(webview, /row\.scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(webview, /row\.focus\(\{ preventScroll: true \}\)/);
  assert.match(webview, /function navigateRunningApps\(direction\)/);
  assert.match(webview, /nextIndex = \(currentIndex \+ direction \+ entries\.length\) % entries\.length/);
  const revealSource = webview.slice(
    webview.indexOf('function revealRunningApp'),
    webview.indexOf('function runningAppRows')
  );
  assert.doesNotMatch(revealSource, /type: '(?:startProject|stopProject|restartProject|openProject)'/);
});
