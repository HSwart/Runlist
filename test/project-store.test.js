const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  initializeProjectStore,
  migrateProjectStore,
  readProjects,
  removeProject,
  upsertProject
} = require('../project-store');

test('reconciles saved projects from both preview extension identities once', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  const firstLegacyFile = path.join(temporaryRoot, 'local.switchboard', 'projects.json');
  const secondLegacyFile = path.join(temporaryRoot, 'hankoswart.switchboard', 'projects.json');
  const projectsFile = path.join(temporaryRoot, 'hankoswart.switchboard-projects', 'projects.json');
  const projectFolder = path.join(temporaryRoot, 'preview-app');
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(path.dirname(firstLegacyFile), { recursive: true });
  fs.mkdirSync(path.dirname(secondLegacyFile), { recursive: true });
  fs.writeFileSync(firstLegacyFile, `${JSON.stringify([{
    id: 'project-1',
    folder: projectFolder,
    name: 'Preview app'
  }])}\n`);
  fs.writeFileSync(secondLegacyFile, '[]\n');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.deepEqual(
    migrateProjectStore(projectsFile, [firstLegacyFile, secondLegacyFile]),
    [firstLegacyFile, secondLegacyFile]
  );
  assert.deepEqual(readProjects(projectsFile), [{
    id: 'project-1',
    folder: projectFolder,
    name: 'Preview app'
  }]);

  fs.writeFileSync(firstLegacyFile, `${JSON.stringify([{ id: 'project-2' }])}\n`);
  assert.deepEqual(migrateProjectStore(projectsFile, [firstLegacyFile]), []);
  assert.equal(readProjects(projectsFile)[0].id, 'project-1');
});

test('keeps unique preview projects and prefers the newer duplicate definition', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  const olderFile = path.join(temporaryRoot, 'local.switchboard', 'projects.json');
  const newerFile = path.join(temporaryRoot, 'hankoswart.switchboard', 'projects.json');
  const projectsFile = path.join(temporaryRoot, 'hankoswart.switchboard-projects', 'projects.json');
  const sharedFolder = path.join(temporaryRoot, 'shared-app');
  fs.mkdirSync(sharedFolder);
  fs.mkdirSync(path.dirname(olderFile), { recursive: true });
  fs.mkdirSync(path.dirname(newerFile), { recursive: true });
  fs.writeFileSync(olderFile, `${JSON.stringify([
    { id: 'shared-old-id', folder: sharedFolder, name: 'Old name' },
    { id: 'older-only', name: 'Older only' }
  ])}\n`);
  fs.writeFileSync(newerFile, `${JSON.stringify([
    { id: 'shared-new-id', folder: sharedFolder, name: 'New name' },
    { id: 'newer-only', name: 'Newer only' }
  ])}\n`);
  fs.utimesSync(olderFile, new Date(1000), new Date(1000));
  fs.utimesSync(newerFile, new Date(2000), new Date(2000));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  migrateProjectStore(projectsFile, [newerFile, olderFile]);

  assert.deepEqual(readProjects(projectsFile).map((project) => project.id), [
    'older-only',
    'shared-new-id',
    'newer-only'
  ]);
});

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
    stopCommand: 'docker compose down',
    services: [{ name: 'web', port: 3001, url: ' https://app.local/dashboard ' }]
  });

  assert.equal(updated.action, 'updated');
  assert.equal(updated.project.id, created.project.id);
  assert.equal(updated.project.name, 'Sample web app');
  assert.equal(readProjects(projectsFile)[0].startCommand, 'pnpm dev');
  assert.equal(readProjects(projectsFile)[0].stopCommand, 'docker compose down');
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
      startCommand: 'npm run dev'
    }),
    /does not exist/
  );
});
