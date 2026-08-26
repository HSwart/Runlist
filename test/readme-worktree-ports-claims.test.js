const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README worktree port claims match sticky vs baseline behavior', () => {
  assert.match(readme, /Git worktrees with port variables get sticky temporary ports/i);
  assert.match(readme, /saved baseline ports stay put/i);
  assert.match(readme, /non-git folders keep current behavior/i);
  assert.doesNotMatch(readme, /create worktrees|delete worktrees|manages? git worktrees/i);
});
