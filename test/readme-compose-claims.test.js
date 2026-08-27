const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README Compose claims match shipped per-service rows and review import', () => {
  assert.match(readme, /one Start\/Stop row per service/i);
  assert.match(readme, /up --no-deps/);
  assert.match(readme, /Import Compose services after review/);
  assert.match(readme, /Docker Engine \+ Compose v2/);
  assert.doesNotMatch(readme, /Kubernetes|Tilt|Swarm|live_update/i);
  assert.doesNotMatch(readme, /auto-?starts? Compose|starts Compose on open/i);
});
