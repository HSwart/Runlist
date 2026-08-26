const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  availableProjectDetailTabs,
  preferredProjectDetailTab
} = require('../src/webview/project-detail-tabs');
const { readShippedHostSource } = require('./helpers/extension-source');

test('offers only relevant detail tabs and defaults to a live preview', () => {
  assert.deepEqual(availableProjectDetailTabs(), ['overview']);
  assert.deepEqual(availableProjectDetailTabs({ outputAvailable: true }), [
    'overview',
    'output'
  ]);
  const liveTabs = availableProjectDetailTabs({
    servicesAvailable: true,
    outputAvailable: true,
    previewAvailable: true,
    historyAvailable: true
  });
  assert.deepEqual(liveTabs, ['overview', 'services', 'output', 'preview', 'history']);
  assert.equal(preferredProjectDetailTab(liveTabs), 'preview');
  assert.equal(preferredProjectDetailTab(liveTabs, 'output'), 'output');
  assert.equal(preferredProjectDetailTab(['overview'], 'preview'), 'overview');
});

test('renders a stable accessible tabbed workspace and preserves its selected tab', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(extension, /availableProjectDetailTabs\([\s\S]*servicesAvailable:[\s\S]*outputAvailable:[\s\S]*previewAvailable:/);
  assert.match(webview, /class="project-detail-tabs" role="tablist"/);
  assert.match(webview, /class="project-detail-tab" role="tab"[\s\S]*aria-selected=/);
  assert.match(webview, /class="project-detail-panel" role="tabpanel"[\s\S]*tabindex="0"/);
  assert.match(webview, /history: historyContent/);
  assert.doesNotMatch(webview, /const overviewContent =[^;]*startupHistoryHtml/);
  assert.match(webview, /vscode\.getState\(\)[\s\S]*vscode\.setState\([\s\S]*detailTabs/);
  assert.match(webview, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\][\s\S]*selectProjectDetailTab/);
  assert.match(webview, /target\.tab[\s\S]*data-tab=/);
  assert.doesNotMatch(styles, /\.project-detail-viewport\s*\{[^}]*height:/);
  assert.doesNotMatch(styles, /\.project-detail-panel\s*\{[^}]*overflow-y:/);
  assert.match(styles, /\.preview-frame-wrap\s*\{[\s\S]*aspect-ratio: 16 \/ 10/);
  assert.match(styles, /\.startup-history-ribbon\s*\{[\s\S]*repeat\(auto-fit, minmax\(52px, 1fr\)\)/);
  assert.doesNotMatch(webview, /--startup-count/);
});

test('keeps live updates inside their tab and loads previews only when visible', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(webview, /const runtime = project\.previewExpanded[\s\S]*class="project-runtime"/);
  assert.match(webview, /overview: overviewContent/);
  assert.match(webview, /data-output-peek-slot[\s\S]*updateProjectOutputPeek/);
  assert.match(webview, /\.project-detail-panel:not\(\[hidden\]\) \[data-preview-frame\]/);
  assert.match(webview, /tab === 'preview'[\s\S]*\.forEach\(loadProjectPreview\)/);
});

test('uses the official refresh Codicon, actionable resource copy, and local addresses', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(webview, /M3 8C3 5\.23858 5\.23858 3 8 3/);
  assert.doesNotMatch(webview, /M13\.6 3\.4A6/);
  assert.doesNotMatch(webview, />Resource use unavailable</);
  assert.match(webview, /Start this project in this VS Code window to measure CPU and memory\./);
  assert.match(webview, /serviceLocalAddress\(service, project\)[\s\S]*class="service-detail-body"/);
  assert.match(webview, /class="preview-toggle"[^>]*data-action="open-services"/);
  assert.match(webview, /class="service-detail-list" aria-label="Services for/);
  assert.match(webview, /`http:\/\/\$\{slug\}\.localhost:\$\{service\.port\}`|`http:\/\/localhost:\$\{service\.port\}`/);
});
