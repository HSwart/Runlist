const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { previewFrameSource, projectPreviewUrl } = require('../preview-security');

const project = {
  id: 'app',
  name: 'App',
  services: [{ name: 'web', port: 4310 }]
};
const serviceUrls = [{ port: 4310, url: 'http://127.0.0.1:4310/dashboard' }];

test('offers a preview only while the primary web service is safely reachable', () => {
  assert.equal(projectPreviewUrl(project, 'running', serviceUrls), serviceUrls[0].url);
  assert.equal(projectPreviewUrl(project, 'active', serviceUrls), serviceUrls[0].url);

  for (const status of ['stopped', 'starting', 'not-ready', 'not-responding', 'stopping']) {
    assert.equal(projectPreviewUrl(project, status, serviceUrls), undefined);
  }
  assert.equal(projectPreviewUrl(project, 'running', [], false), undefined);
  assert.equal(projectPreviewUrl(project, 'running', serviceUrls, true), undefined);
  assert.equal(projectPreviewUrl({ ...project, reviewRequired: true }, 'running', serviceUrls), undefined);
  assert.equal(projectPreviewUrl(project, 'running', [{ port: 4310, url: 'file:///tmp/app' }]), undefined);
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

  assert.match(extension, /this\.expandedPreviewProjectId = this\.expandedPreviewProjectId === id \? undefined : id/);
  assert.match(extension, /frame-src \$\{frameSource\}/);
  assert.match(extension, /this\.focusTarget = \{ type: 'project-control', id: previousId \}/);
  assert.match(webview, /data-action="toggle-preview"[^>]*aria-expanded="\$\{project\.previewExpanded\}"[^>]*aria-controls="preview-/);
  assert.match(webview, /project\.previewExpanded \? `[\s\S]*data-preview-frame data-src=/);
  assert.match(webview, /sandbox="allow-forms allow-scripts allow-same-origin" referrerpolicy="no-referrer"/);
  assert.match(webview, /frame\.src = source/);
  assert.match(webview, /Preview unavailable[\s\S]*This app may block embedded views/);
  assert.match(styles, /\.preview-frame-wrap \{[\s\S]*aspect-ratio: 16 \/ 10/);
  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\)[\s\S]*\.preview-frame/);
});
