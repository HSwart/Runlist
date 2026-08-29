const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readPersistedOwnershipSnapshot } = require('../mcp/persisted-ownership');
const { ProcessOwnershipStore } = require('../src/lifecycle/project-process');

test('readPersistedOwnershipSnapshot matches saved ownership records without process probes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-persisted-ownership-'));
  const projectsFile = path.join(directory, 'projects.json');
  let probeCount = 0;
  const owner = new ProcessOwnershipStore(path.join(directory, 'process-ownership'), {
    pid: process.pid,
    now: () => 1_000,
    isProcessAlive: () => {
      probeCount += 1;
      return true;
    }
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  owner.reserve('project-1');
  owner.setProcess('project-1', process.pid);
  probeCount = 0;

  const snapshot = readPersistedOwnershipSnapshot(projectsFile, 'project-1', 1_000);
  assert.equal(probeCount, 0);
  assert.equal(snapshot.get('project-1')?.state, 'running');
  assert.equal(snapshot.get('project-1')?.ownerHeartbeatFresh, true);
});
