const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  initializeProjectStore,
  readProjects,
  removeProject,
  upsertProject
} = require('../project-store');

test('creates, updates, and removes projects in the shared store', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
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
    stopCommand: 'npm stop',
    services: [{ name: 'web', port: 3001, url: ' https://app.local/dashboard ' }]
  });

  assert.equal(updated.action, 'updated');
  assert.equal(updated.project.id, created.project.id);
  assert.equal(updated.project.name, 'Sample web app');
  assert.equal(readProjects(projectsFile)[0].startCommand, 'pnpm dev');
  assert.equal(readProjects(projectsFile)[0].stopCommand, 'npm stop');
  assert.equal(readProjects(projectsFile)[0].services[0].port, 3001);
  assert.equal(readProjects(projectsFile)[0].services[0].url, 'https://app.local/dashboard');

  const updatedByAgent = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev',
    services: [{ name: 'web', port: 3001 }]
  }, { reviewRequired: true });
  assert.equal(updatedByAgent.project.reviewRequired, true);

  const updatedWithoutReviewOption = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev --host',
    stopCommand: ''
  });
  assert.equal(updatedWithoutReviewOption.project.reviewRequired, true);

  const approved = upsertProject(projectsFile, {
    id: created.project.id,
    folder: projectFolder,
    startCommand: 'pnpm dev',
    stopCommand: ''
  }, { reviewRequired: false });
  assert.equal(approved.project.reviewRequired, false);

  const updatedWithoutName = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev',
    stopCommand: ''
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
    startCommand: 'pnpm dev',
    stopCommand: ''
  });
  assert.equal(resetName.project.name, 'sample-app');
  assert.equal(removeProject(projectsFile, created.project.id), true);
  assert.deepEqual(readProjects(projectsFile), []);
});

test('rejects duplicate service ports', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
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

test('rejects unsafe service URL overrides', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
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
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.throws(
    () => upsertProject(projectsFile, {
      folder: path.join(temporaryRoot, 'missing'),
      startCommand: 'npm run dev',
      stopCommand: ''
    }),
    /does not exist/
  );
});
