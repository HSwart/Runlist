const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README claims Compose import without overreach', () => {
  assert.match(readme, /Docker Compose import/);
  assert.match(readme, /review services first/i);
  assert.match(readme, /not started until you press Start|Compose is not started until you press Start/i);
  assert.doesNotMatch(readme, /Kubernetes|Tilt|Swarm|live_update/i);
  assert.doesNotMatch(readme, /auto-?starts? Compose|starts Compose on open/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
