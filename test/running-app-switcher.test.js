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
  assert.match(styles, /grid-template-columns: auto minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /\.running-app-current[\s\S]*min-width: 0/);
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
