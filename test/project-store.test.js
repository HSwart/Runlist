const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  initializeProjectStore,
  normalizeProjectInput,
  parseProjectDocument,
  readProjects,
  removeProject,
  selectProjectLaunchProfile,
  serializeProjectDocument,
  upsertProject,
  writeProjects
} = require('../src/projects/project-store');

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
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 5);

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
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 5);

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
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).schemaVersion, 5);

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
    schemaVersion: 5,
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
    schemaVersion: 5,
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
  const future = '{"schemaVersion":6,"projects":[]}\n';
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
    schemaVersion: 5,
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
