const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { detectWorktreeIdentity } = require('../src/ports/worktree-identity');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function repoFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-worktree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, ['init']);
  git(main, ['config', 'user.email', 'runlist@example.com']);
  git(main, ['config', 'user.name', 'Runlist']);
  fs.writeFileSync(path.join(main, 'README.md'), 'hello\n');
  git(main, ['add', 'README.md']);
  git(main, ['commit', '-m', 'init']);
  return { root, main: fs.realpathSync(main) };
}

test('returns null for non-git folders', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-nongit-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  assert.equal(detectWorktreeIdentity(folder), null);
  assert.equal(detectWorktreeIdentity(''), null);
  assert.equal(detectWorktreeIdentity(undefined), null);
});

test('distinguishes main worktree from a linked worktree stably', (t) => {
  const { root, main } = repoFixture(t);
  const linked = path.join(root, 'feature');
  git(main, ['worktree', 'add', linked, '-b', 'feature']);
  const linkedRoot = fs.realpathSync(linked);

  const mainIdentity = detectWorktreeIdentity(main);
  const linkedIdentity = detectWorktreeIdentity(linkedRoot);
  const nestedPath = path.join(linkedRoot, 'apps', 'web');
  fs.mkdirSync(nestedPath, { recursive: true });
  const nested = detectWorktreeIdentity(nestedPath);

  assert.equal(mainIdentity.kind, 'git-worktree');
  assert.equal(linkedIdentity.kind, 'git-worktree');
  assert.equal(mainIdentity.commonDir, linkedIdentity.commonDir);
  assert.notEqual(mainIdentity.worktreeRoot, linkedIdentity.worktreeRoot);
  assert.notEqual(mainIdentity.id, linkedIdentity.id);
  assert.equal(detectWorktreeIdentity(main).id, mainIdentity.id);
  assert.equal(detectWorktreeIdentity(linkedRoot).id, linkedIdentity.id);
  assert.equal(nested.id, linkedIdentity.id);
  assert.equal(nested.worktreeRoot, linkedIdentity.worktreeRoot);
});

test('normalizes paths across separators for the same worktree', (t) => {
  const { main } = repoFixture(t);
  const first = detectWorktreeIdentity(main);
  const second = detectWorktreeIdentity(`${main}${path.sep}`);
  assert.equal(first.id, second.id);
  assert.equal(first.worktreeRoot, second.worktreeRoot);
});
