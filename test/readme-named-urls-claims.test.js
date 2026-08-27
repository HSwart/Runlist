const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README claims local hostname without reverse-proxy parity', () => {
  assert.match(readme, /local hostname/i);
  assert.match(readme, /name\.localhost/);
  assert.match(readme, /falls back to `localhost`|fall back to `localhost`/i);
  assert.match(readme, /Open on phone/);
  assert.match(readme, /not a public tunnel/i);
  assert.doesNotMatch(readme, /full Portless|Caddy feature parity|puma-dev parity/i);
  assert.doesNotMatch(readme, /Not a local reverse proxy/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
