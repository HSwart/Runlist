const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  initializeProjectStore,
  normalizeProjectInput,
  parseProjectDocument,
  projectStoreLockRecordIsAbandoned,
  readProjects,
  removeProject,
  saveProjectSnapshot,
  selectProjectLaunchProfile,
  serializeProjectDocument,
  subscribeProjectStoreDiagnostics,
  toggleProjectPinned,
  upsertProject,
  withProjectStoreLockAsync,
  withProjectStoreLock,
  writeProjects
} = require('../src/projects/project-store');

function waitForWorker(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(stderr || `worker exited with ${code}`)));
  });
}

function projectStoreFixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const storageFolder = path.join(temporaryRoot, 'storage');
  const projectsFile = path.join(storageFolder, 'projects.json');
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(storageFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return { temporaryRoot, projectFolder, storageFolder, projectsFile };
}

test('reports project-store lock acquisition, stale recovery, and timeout decisions', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const lockPath = `${projectsFile}.write-lock`;
  let liveLock;
  withProjectStoreLock(projectsFile, () => {
    liveLock = fs.readFileSync(lockPath, 'utf8');
  });
  const events = [];
  const subscription = subscribeProjectStoreDiagnostics(
    projectsFile,
    (event, details) => events.push({ event, ...details })
  );
  t.after(() => subscription.dispose());

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999,
    processIdentity: '999999:dead',
    createdAt: Date.now() - 10000,
    token: 'stale-owner'
  }));
  withProjectStoreLock(projectsFile, () => undefined);

  fs.writeFileSync(lockPath, liveLock);
  assert.throws(() => withProjectStoreLock(projectsFile, () => undefined, {
    maxAttempts: 1,
    retryMs: 0,
    wait: () => undefined
  }), (error) => error?.code === 'STORE_BUSY');
  fs.rmSync(lockPath, { force: true });

  assert.deepEqual(events.map(({ event, reasonCode, attemptCount }) => ({
    event,
    reasonCode,
    attemptCount
  })), [
    {
      event: 'lock.stale-recovered',
      reasonCode: 'owner-absent',
      attemptCount: 1
    },
    {
      event: 'lock.acquired',
      reasonCode: 'after-contention',
      attemptCount: 2
    },
    {
      event: 'lock.timeout',
      reasonCode: 'owner-active-or-uncertain',
      attemptCount: 1
    }
  ]);
});

test('waits for project-store contention without blocking the event loop', async (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const lockPath = `${projectsFile}.write-lock`;
  let liveLock;
  withProjectStoreLock(projectsFile, () => {
    liveLock = fs.readFileSync(lockPath, 'utf8');
  });
  fs.writeFileSync(lockPath, liveLock);

  let eventLoopYielded = false;
  setImmediate(() => { eventLoopYielded = true; });
  setTimeout(() => fs.rmSync(lockPath, { force: true }), 20);

  const result = await withProjectStoreLockAsync(
    projectsFile,
    () => 'updated',
    { retryMs: 5, timeoutMs: 200 }
  );

  assert.equal(result, 'updated');
  assert.equal(eventLoopYielded, true);
});

test('recovers an old partial project-store lock without deleting a fresh write', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const lockPath = `${projectsFile}.write-lock`;
  const events = [];
  const subscription = subscribeProjectStoreDiagnostics(
    projectsFile,
    (event, details) => events.push({ event, ...details })
  );
  t.after(() => subscription.dispose());

  fs.writeFileSync(lockPath, '{"pid":');
  assert.throws(() => withProjectStoreLock(projectsFile, () => undefined, {
    maxAttempts: 1,
    retryMs: 0,
    wait: () => undefined
  }), (error) => error?.code === 'STORE_BUSY');
  assert.equal(fs.existsSync(lockPath), true);

  const old = new Date(Date.now() - 10000);
  fs.utimesSync(lockPath, old, old);
  assert.equal(withProjectStoreLock(projectsFile, () => 'recovered'), 'recovered');
  assert.equal(fs.existsSync(lockPath), false);
  assert.ok(events.some((event) => event.event === 'lock.stale-recovered'
    && event.reasonCode === 'invalid-record'));
});

test('serializes independent project writes across extension hosts', async (t) => {
  const { temporaryRoot, projectsFile } = projectStoreFixture(t);
  const storeModule = path.join(__dirname, '..', 'src', 'projects', 'project-store.js');
  const workerSource = `
    const { upsertProject } = require(process.argv[1]);
    upsertProject(process.argv[2], {
      folder: process.argv[3],
      startCommand: 'npm start',
      services: []
    }, { reviewRequired: false });
  `;
  const workers = Array.from({ length: 8 }, (_, index) => {
    const folder = path.join(temporaryRoot, `worker-${index}`);
    fs.mkdirSync(folder);
    return spawn(process.execPath, [
      '-e', workerSource, storeModule, projectsFile, folder
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  });

  await Promise.all(workers.map(waitForWorker));
  assert.deepEqual(
    readProjects(projectsFile).map((project) => path.basename(project.folder)).sort(),
    Array.from({ length: 8 }, (_, index) => `worker-${index}`)
  );
});

test('does not let a delayed schema migration overwrite a newer project save', async (t) => {
  const { temporaryRoot, projectFolder, projectsFile } = projectStoreFixture(t);
  const storeModule = path.join(__dirname, '..', 'src', 'projects', 'project-store.js');
  const marker = path.join(temporaryRoot, 'migration-read.marker');
  const staleProject = {
    id: 'stale-project',
    name: 'Stale project',
    folder: projectFolder,
    startCommand: 'npm start'
  };
  fs.writeFileSync(projectsFile, JSON.stringify([staleProject]));
  const workerSource = `
    const fs = require('node:fs');
    const originalRead = fs.readFileSync;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    let firstProjectRead = true;
    fs.readFileSync = function(filePath, ...args) {
      const value = originalRead.call(this, filePath, ...args);
      if (firstProjectRead && filePath === process.argv[2]) {
        firstProjectRead = false;
        fs.writeFileSync(process.argv[3], 'read');
        Atomics.wait(wait, 0, 0, 200);
      }
      return value;
    };
    require(process.argv[1]).readProjects(process.argv[2]);
  `;
  const worker = spawn(process.execPath, [
    '-e', workerSource, storeModule, projectsFile, marker
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const deadline = Date.now() + 2000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(marker), true);

  const newerProject = {
    id: 'newer-project',
    name: 'Newer project',
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false
  };
  fs.writeFileSync(projectsFile, serializeProjectDocument([newerProject]));
  await waitForWorker(worker);

  assert.deepEqual(readProjects(projectsFile), [newerProject]);
});

test('rejects an edit snapshot after another window changes the project', (t) => {
  const { projectFolder, projectsFile } = projectStoreFixture(t);
  const saved = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  toggleProjectPinned(projectsFile, saved.id);

  assert.throws(() => upsertProject(projectsFile, {
    ...saved,
    startCommand: 'npm run dev'
  }, {
    expectedProject: saved,
    reviewRequired: false
  }), (error) => error.code === 'STALE_PROJECT');
  assert.equal(readProjects(projectsFile)[0].pinned, true);
});

test('rejects a create snapshot after another window adds the same folder', (t) => {
  const { projectFolder, projectsFile } = projectStoreFixture(t);
  upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false });

  assert.throws(() => upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: []
  }, {
    expectProjectAbsent: true,
    reviewRequired: true
  }), (error) => error.code === 'STALE_PROJECT');
  assert.equal(readProjects(projectsFile)[0].startCommand, 'npm start');
});

test('manual Add cannot overwrite an existing project with the same folder', (t) => {
  const { projectFolder, projectsFile } = projectStoreFixture(t);
  upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false });

  assert.throws(() => saveProjectSnapshot(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run replacement',
    services: []
  }), (error) => error.code === 'STALE_PROJECT'
    && /folder is already saved/i.test(error.message));
  assert.equal(readProjects(projectsFile)[0].startCommand, 'npm start');
});

test('identifies a store lock after its PID is reused by another process identity', () => {
  assert.equal(projectStoreLockRecordIsAbandoned({
    pid: 2147483646,
    processIdentity: '2147483646:original',
    token: 'stale-lock'
  }, {
    kill: () => {},
    platform: 'linux',
    readProcessIdentity: () => '2147483646:replacement'
  }), true);
});

test('keeps a live store lock when its owner identity was unavailable', () => {
  assert.equal(projectStoreLockRecordIsAbandoned({
    pid: 2147483646,
    token: 'live-unverified-lock'
  }, {
    kill: () => {},
    readProcessIdentity: () => '2147483646:replacement'
  }), false);
});

test('probes an uncertain store-lock identity once per bounded acquisition', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const lockPath = `${projectsFile}.write-lock`;
  let identityReads = 0;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483646,
    processIdentity: '2147483646:1000',
    token: 'uncertain-lock'
  }));

  assert.throws(() => withProjectStoreLock(projectsFile, () => undefined, {
    kill: () => {},
    maxAttempts: 3,
    platform: 'win32',
    readProcessIdentity: () => {
      identityReads += 1;
      return undefined;
    },
    retryMs: 0,
    wait: () => undefined
  }), (error) => error?.code === 'STORE_BUSY');
  assert.equal(identityReads, 1);
  assert.equal(fs.existsSync(lockPath), true);
});

test('does not publish an unverifiable fallback identity in a store lock', async (t) => {
  const { temporaryRoot, projectsFile } = projectStoreFixture(t);
  const storeModule = path.join(__dirname, '..', 'src', 'projects', 'project-store.js');
  const capturedLock = path.join(temporaryRoot, 'captured-lock.json');
  const workerSource = `
    const childProcess = require('node:child_process');
    childProcess.execFileSync = () => { throw new Error('identity unavailable'); };
    const fs = require('node:fs');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function(filePath, ...args) {
      if (String(filePath) === '/proc/' + process.pid + '/stat') {
        throw new Error('identity unavailable');
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };
    const { withProjectStoreLock } = require(process.argv[1]);
    withProjectStoreLock(process.argv[2], () => {
      fs.copyFileSync(process.argv[2] + '.write-lock', process.argv[3]);
    });
  `;
  const worker = spawn(process.execPath, [
    '-e', workerSource, storeModule, projectsFile, capturedLock
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  await waitForWorker(worker);
  const lock = JSON.parse(fs.readFileSync(capturedLock, 'utf8'));
  assert.equal(Object.hasOwn(lock, 'processIdentity'), false);
});

test('does not start atomic lock removal for a live unverified store lock', async (t) => {
  const { temporaryRoot, projectsFile } = projectStoreFixture(t);
  const storeModule = path.join(__dirname, '..', 'src', 'projects', 'project-store.js');
  const ownerReady = path.join(temporaryRoot, 'owner-ready');
  const ownerFolder = path.join(temporaryRoot, 'owner-project');
  const contenderFolder = path.join(temporaryRoot, 'contender-project');
  fs.mkdirSync(ownerFolder);
  fs.mkdirSync(contenderFolder);
  const workerSource = `
    const childProcess = require('node:child_process');
    childProcess.execFileSync = () => { throw new Error('identity unavailable'); };
    const fs = require('node:fs');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function(filePath, ...args) {
      if (String(filePath) === '/proc/' + process.pid + '/stat') {
        throw new Error('identity unavailable');
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };
    const { upsertProject, withProjectStoreLock } = require(process.argv[1]);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    withProjectStoreLock(process.argv[2], () => {
      fs.writeFileSync(process.argv[3], 'ready');
      Atomics.wait(wait, 0, 0, 250);
      upsertProject(process.argv[2], {
        folder: process.argv[4],
        startCommand: 'npm start',
        services: []
      }, { reviewRequired: false });
    });
  `;
  const owner = spawn(process.execPath, [
    '-e', workerSource, storeModule, projectsFile, ownerReady, ownerFolder
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ownerDone = waitForWorker(owner);
  t.after(async () => {
    if (owner.exitCode == null && owner.signalCode == null) {
      owner.kill('SIGKILL');
    }
    await ownerDone.catch(() => undefined);
  });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(ownerReady) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(ownerReady), true);

  const originalOpenSync = fs.openSync;
  fs.openSync = function(filePath, ...args) {
    if (String(filePath) === `${projectsFile}.write-lock.update`) {
      const lock = JSON.parse(fs.readFileSync(`${projectsFile}.write-lock`, 'utf8'));
      if (lock.pid === owner.pid) {
        throw new Error('live lock removal must not be started');
      }
    }
    return originalOpenSync.call(this, filePath, ...args);
  };
  try {
    upsertProject(projectsFile, {
      folder: contenderFolder,
      startCommand: 'npm start',
      services: []
    }, { reviewRequired: false });
  } finally {
    fs.openSync = originalOpenSync;
  }
  await ownerDone;

  assert.deepEqual(
    readProjects(projectsFile).map((project) => path.basename(project.folder)).sort(),
    ['contender-project', 'owner-project']
  );
});

test('closes and removes a store lock when writing its metadata fails', (t) => {
  const { projectFolder, projectsFile } = projectStoreFixture(t);
  const originalWrite = fs.writeFileSync;
  let failLockMetadata = true;
  fs.writeFileSync = function(target, ...args) {
    if (failLockMetadata && typeof target === 'number') {
      failLockMetadata = false;
      throw Object.assign(new Error('metadata denied'), { code: 'EIO' });
    }
    return originalWrite.call(this, target, ...args);
  };
  try {
    assert.throws(() => upsertProject(projectsFile, {
      folder: projectFolder,
      startCommand: 'npm start',
      services: []
    }), /metadata denied/);
  } finally {
    fs.writeFileSync = originalWrite;
  }

  assert.equal(fs.existsSync(`${projectsFile}.write-lock`), false);
  assert.equal(upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm start',
    services: []
  }).action, 'created');
});

test('round-trips the current document through the reusable store boundary', (t) => {
  const { projectFolder } = projectStoreFixture(t);
  const projects = [{
    id: 'round-trip',
    name: 'Round trip',
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false
  }];

  const parsed = parseProjectDocument(serializeProjectDocument(projects));

  assert.equal(parsed.legacy, false);
  assert.deepEqual(parsed.projects, projects);
});

test('rejects duplicate project identities and folders in stored data', (t) => {
  const { projectFolder } = projectStoreFixture(t);
  const project = {
    id: 'duplicate',
    name: 'Duplicate',
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false
  };

  assert.throws(
    () => parseProjectDocument(JSON.stringify({
      schemaVersion: 1,
      projects: [project, { ...project, id: 'other' }]
    })),
    /unique identifiers and folders/
  );
  assert.throws(
    () => parseProjectDocument(JSON.stringify({
      schemaVersion: 1,
      projects: [project, { ...project, folder: path.join(projectFolder, 'other') }]
    })),
    /unique identifiers and folders/
  );
});

test('normalizes schema-validated imports while preserving historical names', (t) => {
  const { projectFolder } = projectStoreFixture(t);
  const historicalName = 'a'.repeat(150);

  const project = normalizeProjectInput({
    id: 'imported-project',
    name: historicalName,
    folder: projectFolder,
    startCommand: ' npm run dev ',
    services: []
  }, {
    allowStoredName: true,
    reviewRequired: true
  });

  assert.equal(project.id, 'imported-project');
  assert.equal(project.name, historicalName);
  assert.equal(project.startCommand, 'npm run dev');
  assert.equal(project.reviewRequired, true);
});

test('rejects unsafe control characters in saved start and stop commands', (t) => {
  const { projectFolder, projectsFile } = projectStoreFixture(t);
  const base = {
    folder: projectFolder,
    startCommand: 'npm run dev',
    stopCommand: 'npm run stop',
    services: []
  };

  assert.throws(
    () => normalizeProjectInput({ ...base, startCommand: 'npm run\u0001dev' }),
    /startCommand.*control character/i
  );
  assert.throws(
    () => normalizeProjectInput({ ...base, stopCommand: 'npm stop\u0000' }),
    /stopCommand.*control character/i
  );
  assert.throws(
    () => upsertProject(projectsFile, { ...base, startCommand: 'npm run\u0007dev' }),
    /startCommand.*control character/i
  );
  assert.equal(
    normalizeProjectInput({
      ...base,
      startCommand: 'npm\trun dev\n',
      stopCommand: 'npm run stop\r\n'
    }).startCommand,
    'npm\trun dev'
  );
});

test('migrates version-one projects and persists alternate launch profiles', (t) => {
  const { projectsFile, projectFolder } = projectStoreFixture(t);
  const original = {
    schemaVersion: 1,
    projects: [{
      id: 'profiles',
      name: 'Profiles',
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [],
      reviewRequired: false
    }]
  };
  fs.writeFileSync(projectsFile, `${JSON.stringify(original, null, 2)}\n`);

  assert.equal(readProjects(projectsFile)[0].startCommand, 'npm run dev');
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 10);

  const saved = upsertProject(projectsFile, {
    ...readProjects(projectsFile)[0],
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm test',
      services: [{ name: 'test-api', port: 4311 }]
    }],
    selectedLaunchProfileId: 'tests'
  }).project;
  assert.equal(saved.launchProfiles[0].startCommand, 'npm test');
  assert.equal(saved.selectedLaunchProfileId, 'tests');

  const selectedDefault = selectProjectLaunchProfile(projectsFile, saved.id, 'default');
  assert.equal(Object.hasOwn(selectedDefault, 'selectedLaunchProfileId'), false);
});

test('migrates version-two storage and validates explicit service health checks', (t) => {
  const { projectsFile, projectFolder } = projectStoreFixture(t);
  fs.writeFileSync(projectsFile, `${JSON.stringify({
    schemaVersion: 2,
    projects: [{
      id: 'health',
      name: 'Health',
      folder: projectFolder,
      startCommand: 'npm start',
      services: [{ name: 'web', port: 4310 }],
      reviewRequired: false
    }]
  })}\n`);

  assert.equal(readProjects(projectsFile)[0].services[0].name, 'web');
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 10);

  const updated = upsertProject(projectsFile, {
    ...readProjects(projectsFile)[0],
    services: [{
      name: 'web',
      port: 4310,
      healthCheck: {
        mode: 'http',
        target: '/health',
        method: 'GET',
        expectedStatus: 204,
        timeoutMs: 1200,
        retries: 1
      }
    }]
  }).project;
  assert.equal(updated.services[0].healthCheck.target, '/health');
  assert.throws(() => upsertProject(projectsFile, {
    ...updated,
    services: [{ ...updated.services[0], healthCheck: { mode: 'http', timeoutMs: 5000 } }]
  }), /100 to 3000/);
  assert.throws(() => upsertProject(projectsFile, {
    ...updated,
    services: [{
      ...updated.services[0],
      healthCheck: { mode: 'http', target: '//example.test/health' }
    }]
  }), /safe HTTP URL or path/);
});

test('migrates version-four storage and persists normalized project tags', (t) => {
  const { projectsFile, projectFolder } = projectStoreFixture(t);
  fs.writeFileSync(projectsFile, `${JSON.stringify({
    schemaVersion: 4,
    projects: [{
      id: 'tags',
      name: 'Tags',
      folder: projectFolder,
      startCommand: 'npm start',
      services: [],
      reviewRequired: false
    }]
  })}\n`);

  assert.equal(readProjects(projectsFile)[0].name, 'Tags');
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 10);

  const updated = upsertProject(projectsFile, {
    ...readProjects(projectsFile)[0],
    tags: ['Frontend', 'customer   portal', 'frontend']
  }).project;
  assert.deepEqual(updated.tags, ['Frontend', 'customer portal']);
  assert.throws(() => upsertProject(projectsFile, {
    ...updated,
    tags: ['contains,comma']
  }), /commas/);
});

test('creates a versioned project document while preserving the array API', (t) => {
  const { projectsFile } = projectStoreFixture(t);

  initializeProjectStore(projectsFile);

  assert.deepEqual(JSON.parse(fs.readFileSync(projectsFile, 'utf8')), {
    schemaVersion: 10,
    projects: []
  });
  assert.deepEqual(readProjects(projectsFile), []);
});

test('migrates historical arrays without losing project values or order', (t) => {
  const { projectsFile, projectFolder } = projectStoreFixture(t);
  const legacy = [{
    id: 'legacy-1',
    name: 'Legacy',
    folder: projectFolder,
    startCommand: 'npm run dev',
    stopCommand: 'npm run stop'
  }];
  const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
  fs.writeFileSync(projectsFile, legacyText);

  assert.deepEqual(readProjects(projectsFile), [{
    ...legacy[0],
    services: [],
    reviewRequired: false
  }]);
  assert.equal(fs.readFileSync(`${projectsFile}.bak`, 'utf8'), legacyText);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectsFile, 'utf8')), {
    schemaVersion: 10,
    projects: [{
      ...legacy[0],
      services: [],
      reviewRequired: false
    }]
  });
});

test('preserves a historical folder-derived name above the current input limit', (t) => {
  const { projectsFile, projectFolder } = projectStoreFixture(t);
  const historicalName = 'a'.repeat(150);
  const legacy = [{
    id: 'long-historical-name',
    name: historicalName,
    folder: projectFolder,
    startCommand: 'npm run dev'
  }];
  fs.writeFileSync(projectsFile, `${JSON.stringify(legacy, null, 2)}\n`);

  assert.equal(readProjects(projectsFile)[0].name, historicalName);
});

test('rotates the valid primary into one last-known-good backup', (t) => {
  const { projectsFile, projectFolder } = projectStoreFixture(t);
  initializeProjectStore(projectsFile);
  const previous = fs.readFileSync(projectsFile, 'utf8');

  upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: []
  });

  assert.equal(fs.readFileSync(`${projectsFile}.bak`, 'utf8'), previous);
});

test('restores a valid backup and preserves the damaged primary', (t) => {
  const { projectsFile, temporaryRoot } = projectStoreFixture(t);
  const recoveredProject = {
    id: 'recovered-project',
    name: 'Recovered project',
    folder: path.join(temporaryRoot, 'removed-project'),
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false
  };
  const backup = `${JSON.stringify({
    schemaVersion: 1,
    projects: [recoveredProject]
  }, null, 2)}\n`;
  fs.writeFileSync(`${projectsFile}.bak`, backup);
  fs.writeFileSync(projectsFile, '{ damaged');

  assert.deepEqual(readProjects(projectsFile), [recoveredProject]);
  assert.equal(fs.readFileSync(`${projectsFile}.corrupt`, 'utf8'), '{ damaged');
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), backup);
});

test('restores a missing primary from a valid backup', (t) => {
  const { projectsFile, temporaryRoot } = projectStoreFixture(t);
  const recoveredProject = {
    id: 'backup-only-project',
    name: 'Backup only project',
    folder: path.join(temporaryRoot, 'removed-project'),
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false
  };
  const backup = `${JSON.stringify({
    schemaVersion: 1,
    projects: [recoveredProject]
  }, null, 2)}\n`;
  fs.writeFileSync(`${projectsFile}.bak`, backup);

  assert.deepEqual(readProjects(projectsFile), [recoveredProject]);
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), backup);
  assert.equal(fs.existsSync(`${projectsFile}.corrupt`), false);
});

test('leaves an unrecoverable primary and backup unchanged', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  fs.writeFileSync(projectsFile, '{ primary');
  fs.writeFileSync(`${projectsFile}.bak`, '{ backup');

  assert.throws(() => readProjects(projectsFile), (error) => {
    assert.equal(error.name, 'ProjectStoreError');
    assert.equal(error.code, 'UNRECOVERABLE_STORAGE');
    assert.match(error.message, /did not overwrite/i);
    return true;
  });
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), '{ primary');
  assert.equal(fs.readFileSync(`${projectsFile}.bak`, 'utf8'), '{ backup');
  assert.equal(fs.existsSync(`${projectsFile}.corrupt`), false);
});

test('does not rewrite an unsupported future schema', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const future = '{"schemaVersion":11,"projects":[]}\n';
  fs.writeFileSync(projectsFile, future);

  assert.throws(
    () => readProjects(projectsFile),
    (error) => error.name === 'ProjectStoreError' && error.code === 'UNSUPPORTED_VERSION'
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), future);
  assert.equal(fs.existsSync(`${projectsFile}.bak`), false);
  assert.equal(fs.existsSync(`${projectsFile}.corrupt`), false);
});

test('loads a valid saved project whose folder no longer exists', (t) => {
  const { projectsFile, temporaryRoot } = projectStoreFixture(t);
  const project = {
    id: 'missing-folder',
    name: 'Missing folder',
    folder: path.join(temporaryRoot, 'removed-project'),
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false
  };
  fs.writeFileSync(projectsFile, `${JSON.stringify({
    schemaVersion: 2,
    projects: [project]
  }, null, 2)}\n`);

  assert.deepEqual(readProjects(projectsFile), [project]);
});

test('rejects an invalid version-one project list without rewriting it', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const invalid = '{"schemaVersion":1,"projects":{}}\n';
  fs.writeFileSync(projectsFile, invalid);

  assert.throws(
    () => readProjects(projectsFile),
    (error) => error.name === 'ProjectStoreError' && error.code === 'UNRECOVERABLE_STORAGE'
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), invalid);
});

test('removes its temporary file when atomic replacement fails', (t) => {
  const { projectsFile, storageFolder } = projectStoreFixture(t);
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === projectsFile) {
      const error = new Error('rename blocked');
      error.code = 'EPERM';
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  try {
    assert.throws(() => writeProjects(projectsFile, []), /rename blocked/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(
    fs.readdirSync(storageFolder).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('retries a transient Windows atomic replacement denial', (t) => {
  const { projectsFile } = projectStoreFixture(t);
  const originalRenameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (source, destination) => {
    if (destination === projectsFile && attempts++ === 0) {
      const error = new Error('temporarily blocked');
      error.code = 'EPERM';
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  try {
    initializeProjectStore(projectsFile);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectsFile, 'utf8')), {
    schemaVersion: 10,
    projects: []
  });
});

test('creates, updates, and removes projects in the shared store', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const projectsFile = path.join(temporaryRoot, 'storage', 'projects.json');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  initializeProjectStore(projectsFile);
  const created = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: [{ name: 'web', port: 3000 }]
  });

  assert.equal(created.action, 'created');
  assert.equal(created.project.name, 'sample-app');
  assert.equal(created.project.reviewRequired, false);
  assert.equal(Object.hasOwn(created.project, 'stopCommand'), false);
  assert.deepEqual(created.project.services, [{ name: 'web', port: 3000 }]);
  assert.equal(readProjects(projectsFile).length, 1);

  const updated = upsertProject(projectsFile, {
    name: 'Sample web app',
    folder: projectFolder,
    startCommand: 'pnpm dev',
    stopCommand: 'docker compose down',
    services: [{
      name: 'web',
      port: 3001,
      portVariable: 'PORT',
      url: ' https://app.local/dashboard '
    }]
  });

  assert.equal(updated.action, 'updated');
  assert.equal(updated.project.id, created.project.id);
  assert.equal(updated.project.name, 'Sample web app');
  assert.equal(readProjects(projectsFile)[0].startCommand, 'pnpm dev');
  assert.equal(readProjects(projectsFile)[0].stopCommand, 'docker compose down');
  assert.equal(readProjects(projectsFile)[0].services[0].port, 3001);
  assert.equal(readProjects(projectsFile)[0].services[0].portVariable, 'PORT');
  assert.equal(readProjects(projectsFile)[0].services[0].url, 'https://app.local/dashboard');

  const updatedByAgent = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev',
    services: [{ name: 'web', port: 3001 }]
  }, { reviewRequired: true });
  assert.equal(updatedByAgent.project.reviewRequired, true);

  const updatedWithoutReviewOption = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev --host'
  });
  assert.equal(updatedWithoutReviewOption.project.reviewRequired, true);

  const approved = upsertProject(projectsFile, {
    id: created.project.id,
    folder: projectFolder,
    startCommand: 'pnpm dev'
  }, { reviewRequired: false });
  assert.equal(approved.project.reviewRequired, false);

  const updatedWithoutName = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev'
  });
  assert.equal(updatedWithoutName.project.name, 'Sample web app');

  const clearedServices = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev',
    stopCommand: 'pkill -f vite',
    services: []
  });
  assert.deepEqual(clearedServices.project.services, []);

  const resetName = upsertProject(projectsFile, {
    name: '  ',
    folder: projectFolder,
    startCommand: 'pnpm dev'
  });
  assert.equal(resetName.project.name, 'sample-app');
  assert.equal(removeProject(projectsFile, created.project.id), true);
  assert.deepEqual(readProjects(projectsFile), []);
});

test('does not remove a project that changed after deletion was confirmed', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stale-delete-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const original = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm start'
  }).project;
  const changed = upsertProject(projectsFile, {
    ...original,
    startCommand: 'npm run changed'
  }, { reviewRequired: false }).project;

  assert.throws(
    () => removeProject(projectsFile, original.id, { expectedProject: original }),
    (error) => error.code === 'STALE_PROJECT'
  );
  assert.deepEqual(readProjects(projectsFile), [changed]);
});

test('rejects duplicate service ports', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.throws(
    () => upsertProject(projectsFile, {
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [
        { name: 'web', port: 3000 },
        { name: 'api', port: 3000 }
      ]
    }),
    /ports must be unique/
  );
});

test('rejects invalid and duplicate service port variables', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.throws(() => upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: [{ name: 'web', port: 3000, portVariable: 'PATH' }]
  }), /portVariable/);
  assert.throws(() => upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev',
    services: [
      { name: 'web', port: 3000, portVariable: 'PORT' },
      { name: 'api', port: 4000, portVariable: 'port' }
    ]
  }), /variables must be unique/);
});

test('rejects unsafe service URL overrides', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.throws(
    () => upsertProject(projectsFile, {
      folder: projectFolder,
      startCommand: 'npm run dev',
      stopCommand: 'pkill -f vite',
      services: [{ name: 'web', port: 3000, url: 'file:///tmp/app' }]
    }),
    /valid HTTP or HTTPS URL/
  );
});

test('rejects project folders that do not exist', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.throws(
    () => upsertProject(projectsFile, {
      folder: path.join(temporaryRoot, 'missing'),
      startCommand: 'npm run dev'
    }),
    /does not exist/
  );
});

test('persists relative envFile and env map on projects and profiles', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-store-'));
  const projectFolder = path.join(temporaryRoot, 'sample-app');
  const projectsFile = path.join(temporaryRoot, 'storage', 'projects.json');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  initializeProjectStore(projectsFile);
  const created = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev',
    envFile: '.env',
    env: { FLAG: '1' },
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm test',
      envFile: 'config/.env.tests',
      env: { FLAG: 'tests' },
      services: []
    }],
    services: []
  });

  assert.equal(created.project.envFile, '.env');
  assert.deepEqual(created.project.env, { FLAG: '1' });
  assert.equal(created.project.launchProfiles[0].envFile, 'config/.env.tests');
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 10);

  assert.throws(
    () => upsertProject(projectsFile, {
      folder: projectFolder,
      startCommand: 'npm run dev',
      envFile: '../.env',
      services: []
    }),
    /inside the project folder/i
  );
});

test('migrates schema version 7 documents that omit launch env fields', (t) => {
  const { projectsFile, temporaryRoot } = projectStoreFixture(t);
  const folder = path.join(temporaryRoot, 'hostname-app');
  fs.mkdirSync(folder);
  fs.writeFileSync(projectsFile, `${JSON.stringify({
    schemaVersion: 7,
    projects: [{
      id: 'legacy-host',
      name: 'Legacy',
      folder,
      startCommand: 'npm run dev',
      localHostname: 'legacy',
      services: [],
      reviewRequired: false
    }]
  }, null, 2)}\n`);

  const projects = readProjects(projectsFile);
  assert.equal(projects[0].localHostname, 'legacy');
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 10);
});
