const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createPhoneHandoff } = require('../src/webview/phone-handoff');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README locks signed open-in-browser copy without the named-URL essay', () => {
  assert.match(readme, /Open the app in your browser/);
  assert.doesNotMatch(readme, /## Everyday use/);
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /name\.localhost/);
  assert.doesNotMatch(readme, /falls back to `localhost:port`/i);
  assert.doesNotMatch(readme, /Not a local reverse proxy/i);
  assert.doesNotMatch(readme, /phone handoff uses your LAN address/i);
  assert.doesNotMatch(readme, /full Portless|Caddy feature parity|puma-dev parity/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});

test('phone handoff rewrites *.localhost service URLs to LAN', () => {
  const handoff = createPhoneHandoff('http://web.localhost:4310/', {
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }]
  });
  assert.equal(handoff.url, 'http://192.168.1.20:4310/');
});
