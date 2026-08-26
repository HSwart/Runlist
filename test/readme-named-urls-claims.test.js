const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createPhoneHandoff } = require('../src/webview/phone-handoff');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README named URL claims stay within shipped name+port behavior', () => {
  assert.match(readme, /name\.localhost/);
  assert.match(readme, /falls back to `localhost:port`/i);
  assert.match(readme, /Not a local reverse proxy/i);
  assert.match(readme, /phone handoff uses your LAN address/i);
  assert.doesNotMatch(readme, /full Portless|Caddy feature parity|puma-dev parity/i);
});

test('phone handoff rewrites *.localhost service URLs to LAN', () => {
  const handoff = createPhoneHandoff('http://web.localhost:4310/', {
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }]
  });
  assert.equal(handoff.url, 'http://192.168.1.20:4310/');
});
