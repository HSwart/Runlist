const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README locks the signed listing without the Compose essay', () => {
  assert.match(readme, /Start, stop, and switch local apps from one sidebar\./);
  assert.doesNotMatch(readme, /## Everyday use/);
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /Import Docker Compose services after review/);
  assert.doesNotMatch(readme, /Compose file is not started until you Start/);
  assert.doesNotMatch(readme, /Docker Engine \+ Compose v2/);
  assert.doesNotMatch(readme, /Stop ends only the Compose services that run started/i);
  assert.doesNotMatch(readme, /Kubernetes|Tilt|Swarm|live_update/i);
  assert.doesNotMatch(readme, /auto-?starts? Compose|starts Compose on open/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
