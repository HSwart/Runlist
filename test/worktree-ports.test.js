const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  allocateWorktreePortOverrides,
  readWorktreePortLedger,
  writeWorktreePortLedger
} = require('../src/ports/worktree-ports');
const { detectWorktreeIdentity } = require('../src/ports/worktree-identity');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function twinWorktrees(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-wt-ports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, ['init']);
  git(main, ['config', 'user.email', 'runlist@example.com']);
  git(main, ['config', 'user.name', 'Runlist']);
  fs.writeFileSync(path.join(main, 'README.md'), 'x\n');
  git(main, ['add', 'README.md']);
  git(main, ['commit', '-m', 'init']);
  const linked = path.join(root, 'linked');
  git(main, ['worktree', 'add', linked, '-b', 'linked']);
  const ledgerFile = path.join(root, 'ledger.json');
  return {
    main: fs.realpathSync(main),
    linked: fs.realpathSync(linked),
    ledgerFile,
    project(folder) {
      return {
        id: 'proj-1',
        name: 'App',
        folder,
        startCommand: 'npm run dev',
        services: [
          { name: 'web', port: 3000, portVariable: 'PORT' },
          { name: 'api', port: 4000, portVariable: 'API_PORT' }
        ]
      };
    }
  };
}

test('reuses sticky ports for the same worktree and separates linked worktrees', (t) => {
  const fixture = twinWorktrees(t);
  const mainId = detectWorktreeIdentity(fixture.main);
  const linkedId = detectWorktreeIdentity(fixture.linked);
  const first = allocateWorktreePortOverrides({
    project: fixture.project(fixture.main),
    identity: mainId,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });
  const again = allocateWorktreePortOverrides({
    project: fixture.project(fixture.main),
    identity: mainId,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });
  const other = allocateWorktreePortOverrides({
    project: fixture.project(fixture.linked),
    identity: linkedId,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });

  assert.equal(first.overrides.length, 2);
  assert.deepEqual(again.overrides, first.overrides);
  assert.notEqual(other.overrides[0].port, first.overrides[0].port);
  assert.notEqual(other.overrides[1].port, first.overrides[1].port);
  assert.equal(first.overrides[0].savedPort, 3000);
  assert.equal(first.overrides[0].variable, 'PORT');
});

test('fails fast when sticky ports cannot be reserved', (t) => {
  const fixture = twinWorktrees(t);
  const identity = detectWorktreeIdentity(fixture.main);
  assert.throws(
    () => allocateWorktreePortOverrides({
      project: fixture.project(fixture.main),
      identity,
      ledgerFile: fixture.ledgerFile,
      isPortFree: () => false
    }),
    /could not reserve|worktree ports/i
  );
});

test('skips sticky allocation when services lack port variables', (t) => {
  const fixture = twinWorktrees(t);
  const identity = detectWorktreeIdentity(fixture.main);
  const result = allocateWorktreePortOverrides({
    project: {
      ...fixture.project(fixture.main),
      services: [{ name: 'web', port: 3000 }]
    },
    identity,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });
  assert.equal(result, null);
});

test('ledger round-trips through disk', (t) => {
  const fixture = twinWorktrees(t);
  writeWorktreePortLedger(fixture.ledgerFile, {
    entries: [{
      projectId: 'proj-1',
      worktreeId: 'abc',
      overrides: [{ serviceName: 'web', savedPort: 3000, port: 3100, variable: 'PORT' }]
    }]
  });
  assert.equal(readWorktreePortLedger(fixture.ledgerFile).entries[0].worktreeId, 'abc');
});
