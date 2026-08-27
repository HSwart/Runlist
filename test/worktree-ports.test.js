const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  WorktreePortsError,
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

function staleProcessLockIdentity(liveIdentity, pid) {
  const darwinV2 = String(liveIdentity).match(
    new RegExp(`^${pid}:darwin:v2:(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}):([a-f0-9]{64})$`)
  );
  if (darwinV2) {
    const hash = darwinV2[2];
    const flipped = `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`;
    return `${pid}:darwin:v2:${darwinV2[1]}:${flipped}`;
  }
  if (new RegExp(`^${pid}:runtime:\\d+$`).test(liveIdentity)) {
    return liveIdentity.replace(/:runtime:(\d+)$/, (_, ticks) => `:runtime:${BigInt(ticks) + 1n}`);
  }
  const linuxOrWindows = String(liveIdentity).match(new RegExp(`^${pid}:(?:linux:)?(\\d+)$`));
  if (linuxOrWindows) {
    const prefix = String(liveIdentity).includes(':linux:') ? `${pid}:linux:` : `${pid}:`;
    return `${prefix}${BigInt(linuxOrWindows[1]) + 1n}`;
  }
  throw new Error(`cannot derive a stale lock identity from ${liveIdentity}`);
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

test('corrupt ledger fails closed and allocate does not wipe prior entries', (t) => {
  const fixture = twinWorktrees(t);
  const identity = detectWorktreeIdentity(fixture.main);

  fs.writeFileSync(fixture.ledgerFile, '{not-json');
  assert.throws(
    () => readWorktreePortLedger(fixture.ledgerFile),
    (error) => error instanceof WorktreePortsError && error.code === 'LEDGER_CORRUPT'
  );
  assert.throws(
    () => allocateWorktreePortOverrides({
      project: fixture.project(fixture.main),
      identity,
      ledgerFile: fixture.ledgerFile,
      isPortFree: () => true
    }),
    (error) => error instanceof WorktreePortsError && error.code === 'LEDGER_CORRUPT'
  );
  assert.equal(fs.readFileSync(fixture.ledgerFile, 'utf8'), '{not-json');

  fs.writeFileSync(fixture.ledgerFile, '[]');
  assert.throws(
    () => allocateWorktreePortOverrides({
      project: fixture.project(fixture.main),
      identity,
      ledgerFile: fixture.ledgerFile,
      isPortFree: () => true
    }),
    (error) => error instanceof WorktreePortsError && error.code === 'LEDGER_CORRUPT'
  );
  assert.equal(fs.readFileSync(fixture.ledgerFile, 'utf8'), '[]');

  fs.writeFileSync(fixture.ledgerFile, JSON.stringify({ schemaVersion: 1 }));
  assert.throws(
    () => allocateWorktreePortOverrides({
      project: fixture.project(fixture.main),
      identity,
      ledgerFile: fixture.ledgerFile,
      isPortFree: () => true
    }),
    (error) => error instanceof WorktreePortsError && error.code === 'LEDGER_CORRUPT'
  );
  assert.equal(
    fs.readFileSync(fixture.ledgerFile, 'utf8'),
    JSON.stringify({ schemaVersion: 1 })
  );
});

test('missing ledger still starts empty and allocates', (t) => {
  const fixture = twinWorktrees(t);
  const identity = detectWorktreeIdentity(fixture.main);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
  assert.deepEqual(readWorktreePortLedger(fixture.ledgerFile), {
    schemaVersion: 1,
    entries: []
  });
  const result = allocateWorktreePortOverrides({
    project: fixture.project(fixture.main),
    identity,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });
  assert.equal(result.overrides.length, 2);
  assert.equal(readWorktreePortLedger(fixture.ledgerFile).entries.length, 1);
});

test('does not reclaim a live ledger lock by age alone', (t) => {
  const fixture = twinWorktrees(t);
  const lockPath = `${fixture.ledgerFile}.lock`;
  const { currentProcessIdentity } = require('../src/lifecycle/process-identity');
  const liveIdentity = currentProcessIdentity({ allowRuntimeFallback: true });
  assert.ok(liveIdentity, 'current process identity must be available for this lock test');
  const liveLock = JSON.stringify({
    pid: process.pid,
    processIdentity: liveIdentity,
    createdAt: Date.now() - 10_000
  });
  fs.mkdirSync(path.dirname(fixture.ledgerFile), { recursive: true });
  fs.writeFileSync(lockPath, liveLock);
  const identity = detectWorktreeIdentity(fixture.main);

  assert.throws(
    () => allocateWorktreePortOverrides({
      project: fixture.project(fixture.main),
      identity,
      ledgerFile: fixture.ledgerFile,
      isPortFree: () => true
    }),
    (error) => error instanceof WorktreePortsError && error.code === 'LEDGER_BUSY'
  );
  assert.equal(fs.readFileSync(lockPath, 'utf8'), liveLock);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
});

test('reclaims an abandoned ledger lock whose owner pid is dead', (t) => {
  const fixture = twinWorktrees(t);
  const lockPath = `${fixture.ledgerFile}.lock`;
  fs.mkdirSync(path.dirname(fixture.ledgerFile), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483646,
    processIdentity: '2147483646:linux:1000',
    createdAt: Date.now() - 10_000
  }));
  const identity = detectWorktreeIdentity(fixture.main);

  const result = allocateWorktreePortOverrides({
    project: fixture.project(fixture.main),
    identity,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });
  assert.equal(result.overrides.length, 2);
  assert.equal(fs.existsSync(lockPath), false);
});

test('reclaims a ledger lock when a reused pid fails identity match', (t) => {
  const fixture = twinWorktrees(t);
  const lockPath = `${fixture.ledgerFile}.lock`;
  const { currentProcessIdentity } = require('../src/lifecycle/process-identity');
  const liveIdentity = currentProcessIdentity({ allowRuntimeFallback: true });
  assert.ok(liveIdentity, 'current process identity must be available for this lock test');
  const staleIdentity = staleProcessLockIdentity(liveIdentity, process.pid);
  assert.notEqual(staleIdentity, liveIdentity);
  fs.mkdirSync(path.dirname(fixture.ledgerFile), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    processIdentity: staleIdentity,
    createdAt: Date.now() - 10_000
  }));
  const identity = detectWorktreeIdentity(fixture.main);

  const result = allocateWorktreePortOverrides({
    project: fixture.project(fixture.main),
    identity,
    ledgerFile: fixture.ledgerFile,
    isPortFree: () => true
  });
  assert.equal(result.overrides.length, 2);
  assert.equal(fs.existsSync(lockPath), false);
});

test('worktree ledger locks include processIdentity in the written record', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ports', 'worktree-ports.js'),
    'utf8'
  );
  assert.match(source, /worktreeLockProcessIdentity|currentProcessIdentity/);
  assert.match(source, /processIdentity/);
  assert.match(source, /currentProcessIdentity: processIdentity/);
});
