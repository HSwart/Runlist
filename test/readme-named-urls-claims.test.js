const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README claims local hostname without reverse-proxy parity', () => {
  assert.match(readme, /Open the app from the port chip|Open the app when it\u2019s ready|Open the app in your browser|Optional local hostname/);
  assert.match(readme, /name\.localhost|local hostname/i);
  assert.match(readme, /fall back to `localhost`|fallback to `localhost`|fall back to localhost/i);
  assert.doesNotMatch(readme, /full Portless|Caddy feature parity|puma-dev parity/i);
  assert.doesNotMatch(readme, /Not a local reverse proxy/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
