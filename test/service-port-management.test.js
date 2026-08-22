const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('offers an accessible Resolve action only for an affected service', () => {
  const root = path.join(__dirname, '..');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(webview, /const portBlocked = conflicted[\s\S]*project\.portConflict\?\.port === service\.port/);
  assert.match(webview, /const canUseUrl =[\s\S]*&& !portBlocked/);
  assert.match(webview, /projectStatus === 'not-ready' && waiting/);
  assert.match(webview, /class="service-detail-state">\$\{details\.state\}/);
  assert.match(webview, /data-action="resolve-service-port"[^>]*>\$\{icon\('refresh'\)\}<span>Resolve port<\/span>/);
  assert.match(webview, /type: 'resolveServicePort'[^}]*id: button\.dataset\.id[^}]*port: Number\(button\.dataset\.port\)/);
  assert.match(styles, /\.service-detail-toggle \{[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto auto auto/);
  assert.doesNotMatch(webview, /class="service-chip"/);
  assert.match(styles, /@media \(pointer: coarse\)[\s\S]*\.service-detail-actions button[\s\S]*min-height: 44px/);
});

test('keeps temporary launch details accessible without adding a second service row', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

  assert.match(webview, /service\.temporaryPort/);
  assert.match(webview, /Temporary for this launch\. Saved as port \$\{savedPort\} via \$\{service\.portVariable\}/);
  assert.match(webview, /class="service-detail-body"[\s\S]*\$\{temporaryDetail \? `<p>/);
  assert.doesNotMatch(webview, /service-temporary-badge/);
  assert.match(webview, /const savedPort = service\.savedPort \|\| service\.port/);
});

test('keeps optional service configuration collapsed in narrow forms', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

  assert.match(webview, /<details class="service-options"/);
  assert.match(webview, /serviceOptionsInvalid \? 'open' : ''/);
  assert.match(webview, /<summary>Options/);
  assert.doesNotMatch(webview, />Port variable <span/);
  assert.match(styles, /\.service-options \{[\s\S]*grid-column: 1 \/ 3/);
});

test('collects temporary port settings on the fly without editing the project', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(extension, /label: managed \? 'Restart with a temporary port' : 'Use a temporary port'/);
  assert.doesNotMatch(extension, /Configure temporary ports/);
  assert.match(extension, /prompt: `Port environment variable used by \$\{service\.name\}\. This applies to this launch only\.`/);
  assert.match(extension, /placeHolder: 'For example, API_PORT'/);
  assert.match(extension, /prompt: `Temporary port for \$\{service\.name\}\. The saved port remains :\$\{service\.port\}\.`/);
  assert.match(extension, /variable: portVariable/);
});

test('threads temporary ports through reservation, environment, ownership, and exact recovery', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(extension, /this\.portReservations\.reserve\(launchProject\)/);
  assert.match(extension, /servicePortStatus\(launchProject\.services\)/);
  assert.match(extension, /env: projectLaunchEnvironment\(process\.env, portOverrides\)/);
  assert.match(extension, /recordStartedProcess\([\s\S]*launchProject[\s\S]*portOverrides/);
  assert.match(extension, /const launchToken = this\.processOwnership\.snapshot\(\)\.get\(project\.id\)\?\.token/);
  assert.match(extension, /waitUntilServiceReady\([\s\S]*launchIsCurrent/);
  assert.match(extension, /expectedOwnershipToken: launchToken/);
  assert.match(extension, /recoveryProject = selectedService[\s\S]*services: \[selectedService\]/);
  assert.match(extension, /forceCloseProjectPorts\(id, 'start', \{ servicePort: savedPort \}\)/);
  assert.match(extension, /displayedConflict\?\.port !== savedPort/);
  assert.match(extension, /this\.startProject\(id, \{ allowPortConflict: true \}\)/);
  assert.match(webview, /port: element\.dataset\.port/);
  assert.match(webview, /selector \+= `\[data-port=/);
  assert.match(extension, /handleProjectStoreChange\(\)[\s\S]*this\.statusRevision \+= 1/);
  assert.match(extension, /this\.statusRefreshPending = true/);
});
