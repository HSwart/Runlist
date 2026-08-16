const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('renders an accessible copy action only for a reachable service URL', () => {
  const root = path.join(__dirname, '..');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(webview, /project\.serviceUrls\?\.some\(\(entry\) => entry\.port === service\.port\)/);
  assert.match(webview, /data-action="copy-service-url"[^>]*data-id="\$\{projectId\}"[^>]*data-port=/);
  assert.match(webview, /aria-label="\$\{copyLabel\}" title="\$\{copyLabel\}"/);
  assert.match(webview, /type: 'copyServiceUrl',[\s\S]*port: Number\(button\.dataset\.port\)/);
});

test('rechecks reachability and copies the forwarded safe URL in the extension host', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(extension, /case 'copyServiceUrl':[\s\S]*await this\.copyServiceUrl\(message\.id, Number\(message\.port\)\)/);
  assert.match(extension, /async copyServiceUrl\(id, port\)[\s\S]*servicePortStatus\(\[service\]\)[\s\S]*reachableServiceUrls\(\[service\]/);
  assert.match(extension, /resolveUrl: \(url\) => this\.externalServiceUrl\(url\)/);
  assert.match(extension, /vscode\.env\.clipboard\.writeText\(reachable\.url\)/);
  assert.match(extension, /Copied \$\{service\.name\} URL\./);
});
