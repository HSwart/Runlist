const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const host = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
  'utf8'
);
const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const capability = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lifecycle', 'lifecycle-capability.js'),
  'utf8'
);

test('sidebar explains Compose Start is unavailable when Docker is missing', () => {
  assert.match(host, /refreshComposeAvailabilityNotice\(/);
  assert.match(host, /composeNotice/);
  assert.match(host, /probeComposeAvailability\(/);
  assert.match(host, /Compose projects stay listed, but Start is unavailable/);
  assert.match(webview, /state\.composeNotice/);
  assert.match(webview, /aria-label="Compose availability"/);
  assert.doesNotMatch(webview, /project-compose-cue/);
});

test('remote windows stay fail-closed for lifecycle and Compose Start', () => {
  assert.match(capability, /codespaces|dev-container|ssh-remote|tunnel/);
  assert.match(host, /Compose projects cannot start in this window/);
  assert.match(webview, /Remote SSH, Dev Containers, GitHub Codespaces/);
});
