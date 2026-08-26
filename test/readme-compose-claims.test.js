const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README Compose claims match shipped review-before-run behavior', () => {
  assert.match(readme, /Import Docker Compose services after review/);
  assert.match(readme, /Compose file is not started until you Start/);
  assert.match(readme, /Docker Engine \+ Compose v2/);
  assert.match(readme, /Stop ends only the Compose services that run started/i);
  assert.doesNotMatch(readme, /Kubernetes|Tilt|Swarm|live_update/i);
  assert.doesNotMatch(readme, /auto-?starts? Compose|starts Compose on open/i);
});
