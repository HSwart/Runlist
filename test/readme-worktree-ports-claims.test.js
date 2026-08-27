const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Marketplace README omits worktree sticky-port essay', () => {
  assert.match(readme, /Start, stop, and switch local apps from one sidebar\./);
  assert.doesNotMatch(readme, /Git worktrees with port variables get sticky temporary ports/i);
  assert.doesNotMatch(readme, /saved baseline ports stay put/i);
  assert.doesNotMatch(readme, /non-git folders keep current behavior/i);
  assert.doesNotMatch(readme, /create worktrees|delete worktrees|manages? git worktrees/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});
