const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  previewFrameSource,
  projectPreviewService,
  projectPreviewUrl
} = require('../preview-security');

const project = {
  id: 'app',
  name: 'App',
  services: [{ name: 'web', port: 4310 }]
};
const serviceUrls = [{ port: 4310, url: 'http://127.0.0.1:4310/dashboard' }];

test('offers a preview while a safe web service is reachable', () => {
  for (const status of ['running', 'starting', 'not-ready', 'not-responding', 'active']) {
    assert.equal(projectPreviewUrl(project, status, serviceUrls), serviceUrls[0].url);
  }

  for (const status of ['stopped', 'stopping']) {
    assert.equal(projectPreviewUrl(project, status, serviceUrls), undefined);
  }
  assert.equal(projectPreviewUrl(project, 'running', [], false), undefined);
  assert.equal(projectPreviewUrl(project, 'running', serviceUrls, true), undefined);
  assert.equal(projectPreviewUrl({ ...project, reviewRequired: true }, 'running', serviceUrls), undefined);
  assert.equal(projectPreviewUrl(project, 'running', [{ port: 4310, url: 'file:///tmp/app' }]), undefined);
});

test('selects the first responding web service in saved order during partial startup', () => {
  const multiServiceProject = {
    id: 'multi',
    name: 'Multi-service app',
    services: [
      { name: 'api', port: 4311 },
      { name: 'dashboard', port: 5173, url: 'https://dashboard.example.test/app' },
      { name: 'admin', port: 4173, url: 'http://127.0.0.1:4173/admin' }
    ]
  };
  const respondingUrls = [
    { port: 4173, url: 'http://127.0.0.1:4173/admin' },
    { port: 5173, url: 'https://dashboard.example.test/app' }
  ];

  assert.deepEqual(
    projectPreviewService(multiServiceProject, 'starting', respondingUrls),
    { port: 5173, url: 'https://dashboard.example.test/app' }
  );
  assert.deepEqual(
    projectPreviewService(multiServiceProject, 'not-ready', respondingUrls),
    { port: 5173, url: 'https://dashboard.example.test/app' }
  );
  assert.deepEqual(
    projectPreviewService(multiServiceProject, 'running', [respondingUrls[0]]),
    { port: 4173, url: 'http://127.0.0.1:4173/admin' }
  );
  assert.equal(projectPreviewService(multiServiceProject, 'running', []), undefined);
  assert.equal(projectPreviewService(multiServiceProject, 'running', respondingUrls, true), undefined);
});

test('limits preview CSP sources to a safe HTTP or HTTPS origin', () => {
  assert.equal(previewFrameSource('https://app.example.test/path?view=all'), 'https://app.example.test');
  assert.equal(previewFrameSource('http://[::1]:4310/dashboard'), 'http://[::1]:4310');
  assert.equal(previewFrameSource('https://user:secret@example.test'), "'none'");
  assert.equal(previewFrameSource('javascript:alert(1)'), "'none'");
  assert.equal(previewFrameSource(), "'none'");
});

test('renders one lazy, sandboxed, accessible expandable preview', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(extension, /this\.expandedPreviewServicePort === previewService\.port/);
  assert.match(extension, /this\.expandedPreviewServicePort = previewService\.port/);
  assert.match(extension, /detailsExpanded = this\.expandedPreviewProjectId === project\.id[\s\S]*this\.expandedPreviewServicePort === previewService\.port/);
  assert.match(extension, /previewExpanded = canPreview && detailsExpanded/);
  assert.match(extension, /this\.expandedPreviewProjectId = undefined;[\s\S]*this\.expandedPreviewServicePort = undefined;[\s\S]*type: 'project-control'/);
  assert.match(extension, /this\.startAttempts\.set\(id, attempt\);[\s\S]*this\.projectServiceUrls\.delete\(id\);[\s\S]*this\.projectStatuses\.set\(id, 'starting'\)/);
  assert.match(extension, /frame-src \$\{frameSource\}/);
  assert.match(extension, /this\.focusTarget = \{ type: 'project-control', id: previousId \}/);
  assert.match(webview, /data-action="toggle-preview"[^>]*aria-expanded="\$\{project\.detailsExpanded\}"[^>]*aria-controls="details-/);
  assert.match(webview, /title="\$\{project\.detailsExpanded \? 'Collapse' : 'Expand'\} \$\{project\.timeline \? 'live project details' : 'app preview'\}">\$\{icon\('chevron-down'\)\}/);
  assert.match(webview, /id="details-\$\{projectId\}" class="project-live-details" \$\{project\.detailsExpanded \? '' : 'hidden'\}/);
  assert.match(webview, /data-timeline-elapsed data-started-at=/);
  assert.doesNotMatch(webview, /data-timeline-elapsed[^>]*aria-live/);
  assert.match(webview, /\(timeline\.failed \|\| timeline\.attention\) && timeline\.outputAvailable/);
  assert.doesNotMatch(webview, /icon\('arrow-down'\)/);
  assert.match(webview, /class="project-services-row">[\s\S]*class="project-services"[\s\S]*class="preview-toggle"/);
  assert.match(webview, /project\.previewExpanded \? `[\s\S]*data-preview-frame data-src=/);
  assert.match(webview, /sandbox="allow-forms allow-scripts allow-same-origin" referrerpolicy="no-referrer"/);
  assert.match(webview, /frame\.src = source/);
  assert.match(webview, /Preview unavailable[\s\S]*This app may block embedded views/);
  assert.match(styles, /\.preview-frame-wrap \{[\s\S]*aspect-ratio: 16 \/ 10/);
  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\)[\s\S]*\.preview-frame/);
});

test('uses the selected preview service for copy and browser actions', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /async openProject\(id\)[\s\S]*projectPreviewService\([\s\S]*servicePortStatus\(\[service\]\)[\s\S]*reachableServiceUrls\(\[service\][\s\S]*openExternal\(vscode\.Uri\.parse\(reachable\.url\)\)/);
  assert.match(extension, /previewPort: previewService\?\.port/);
  assert.match(webview, /const canOpen = Boolean\(project\.previewUrl\)/);
  assert.match(webview, /stopState[\s\S]*does not have a responding web service yet/);
  assert.match(webview, /data-action="copy-service-url"[^>]*data-port="\$\{escapeHtml\(String\(project\.previewPort\)\)\}"/);
  assert.doesNotMatch(webview, /project\.services\[0\]\.port/);
});
