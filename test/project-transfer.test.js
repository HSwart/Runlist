const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readProjects, writeProjects } = require('../src/projects/project-store');
const {
  applyProjectImport,
  exportProjectDocument,
  parseImportDocument,
  previewProjectImport,
  ProjectTransferError
} = require('../src/projects/project-transfer');

function transferFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-transfer-'));
  const projectsFile = path.join(root, 'storage', 'projects.json');
  fs.mkdirSync(path.dirname(projectsFile));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    projectsFile,
    folder(name) {
      const folderPath = path.join(root, name);
      fs.mkdirSync(folderPath, { recursive: true });
      return fs.realpathSync(folderPath);
    }
  };
}

function project(id, name, folder, overrides = {}) {
  return {
    id,
    name,
    folder,
    startCommand: 'npm run dev',
    services: [],
    reviewRequired: false,
    ...overrides
  };
}

test('exports selected or complete project lists as current documents', (t) => {
  const fixture = transferFixture(t);
  const first = project('first', 'First', fixture.folder('first'));
  const second = project('second', 'Second', fixture.folder('second'), { pinned: true });

  assert.deepEqual(JSON.parse(exportProjectDocument([first])), {
    schemaVersion: 7,
    projects: [first]
  });
  assert.deepEqual(parseImportDocument(exportProjectDocument([first, second])), [first, second]);
});

test('rejects legacy, future, and oversized import documents', () => {
  assert.throws(
    () => parseImportDocument('[]'),
    (error) => error instanceof ProjectTransferError && error.code === 'UNSUPPORTED_IMPORT_FORMAT'
  );
  assert.throws(
    () => parseImportDocument('{"schemaVersion":8,"projects":[]}'),
    (error) => error instanceof ProjectTransferError && error.code === 'UNSUPPORTED_IMPORT_VERSION'
  );
  assert.throws(
    () => parseImportDocument(' '.repeat((5 * 1024 * 1024) + 1)),
    (error) => error instanceof ProjectTransferError && error.code === 'IMPORT_TOO_LARGE'
  );
});

test('classifies additions, updates, unchanged setups, and invalid entries', (t) => {
  const fixture = transferFixture(t);
  const skipFolder = fixture.folder('skip');
  const updateFolder = fixture.folder('update');
  const addFolder = fixture.folder('add');
  const current = [
    project('skip-id', 'Skip', skipFolder),
    project('update-id', 'Update', updateFolder)
  ];
  const imported = [
    project('other-skip-id', 'Skip', skipFolder),
    project('other-update-id', 'Updated name', updateFolder),
    project('add-id', 'Add', addFolder),
    project('invalid-id', 'Invalid', path.join(fixture.root, 'missing'))
  ];

  const preview = previewProjectImport(current, imported);

  assert.deepEqual(preview.entries.map((entry) => entry.status), [
    'skip',
    'update',
    'add',
    'invalid'
  ]);
  assert.equal(preview.entries[1].project.id, 'update-id');
  assert.equal(preview.entries[1].project.reviewRequired, true);
  assert.equal(preview.entries[2].project.id, 'add-id');
  assert.equal(preview.entries[2].project.reviewRequired, true);
  assert.match(preview.entries[3].reason, /does not exist/i);
  assert.equal(preview.changeCount, 2);
  assert.deepEqual(preview.nextProjects.map((item) => item.id), [
    'skip-id',
    'update-id',
    'add-id'
  ]);
});

test('marks every repeated imported folder invalid', (t) => {
  const fixture = transferFixture(t);
  const folder = fixture.folder('duplicate');

  const preview = previewProjectImport([], [
    project('first', 'First', folder),
    project('second', 'Second', folder)
  ]);

  assert.deepEqual(preview.entries.map((entry) => entry.status), ['invalid', 'invalid']);
  assert.match(preview.entries[0].reason, /repeated folder/i);
  assert.equal(preview.changeCount, 0);
});

test('rejects imported identifiers that collide with another folder', (t) => {
  const fixture = transferFixture(t);
  const current = [project('existing-id', 'Existing', fixture.folder('existing'))];

  const preview = previewProjectImport(current, [
    project('existing-id', 'Different', fixture.folder('different'))
  ]);

  assert.equal(preview.entries[0].status, 'invalid');
  assert.match(preview.entries[0].reason, /identifier/i);
  assert.deepEqual(preview.nextProjects, current);
});

test('blocks updates to active projects without blocking unrelated additions', (t) => {
  const fixture = transferFixture(t);
  const activeFolder = fixture.folder('active');
  const addFolder = fixture.folder('add');
  const current = [project('active-id', 'Active', activeFolder)];

  const preview = previewProjectImport(current, [
    project('incoming-active', 'Changed', activeFolder),
    project('add-id', 'Add', addFolder)
  ], {
    isProjectActive: (existing) => existing.id === 'active-id'
  });

  assert.deepEqual(preview.entries.map((entry) => entry.status), ['invalid', 'add']);
  assert.match(preview.entries[0].reason, /running or changing state/i);
  assert.equal(preview.changeCount, 1);
});

test('applies a confirmed preview with one versioned store replacement', (t) => {
  const fixture = transferFixture(t);
  const existing = project('existing-id', 'Existing', fixture.folder('existing'));
  const added = project('added-id', 'Added', fixture.folder('added'));
  writeProjects(fixture.projectsFile, [existing]);
  const before = fs.readFileSync(fixture.projectsFile, 'utf8');
  const preview = previewProjectImport(readProjects(fixture.projectsFile), [added]);

  const result = applyProjectImport(fixture.projectsFile, preview);

  assert.deepEqual(result.map((item) => item.id), ['existing-id', 'added-id']);
  assert.equal(result[1].reviewRequired, true);
  assert.equal(fs.readFileSync(`${fixture.projectsFile}.bak`, 'utf8'), before);
  assert.deepEqual(readProjects(fixture.projectsFile), result);
});

test('current exports clear optional project metadata omitted by the source', (t) => {
  const fixture = transferFixture(t);
  const folder = fixture.folder('replace-metadata');
  const existing = {
    ...project('existing-id', 'Existing', folder),
    pinned: true,
    tags: ['frontend'],
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm test',
      services: []
    }],
    selectedLaunchProfileId: 'tests'
  };
  const imported = parseImportDocument(exportProjectDocument([
    project('incoming-id', 'Existing', folder)
  ]));

  const preview = previewProjectImport([existing], imported);
  assert.equal(preview.entries[0].status, 'update');
  assert.equal(preview.entries[0].project.pinned, undefined);
  assert.equal(preview.entries[0].project.tags, undefined);
  assert.equal(preview.entries[0].project.launchProfiles, undefined);
  assert.equal(preview.entries[0].project.selectedLaunchProfileId, undefined);
});

test('rejects a stale preview without replacing newer project data', (t) => {
  const fixture = transferFixture(t);
  const initial = project('initial-id', 'Initial', fixture.folder('initial'));
  const imported = project('imported-id', 'Imported', fixture.folder('imported'));
  const newer = project('newer-id', 'Newer', fixture.folder('newer'));
  writeProjects(fixture.projectsFile, [initial]);
  const preview = previewProjectImport(readProjects(fixture.projectsFile), [imported]);
  writeProjects(fixture.projectsFile, [initial, newer]);
  const beforeApply = fs.readFileSync(fixture.projectsFile, 'utf8');

  assert.throws(
    () => applyProjectImport(fixture.projectsFile, preview),
    (error) => error instanceof ProjectTransferError && error.code === 'STALE_IMPORT'
  );
  assert.equal(fs.readFileSync(fixture.projectsFile, 'utf8'), beforeApply);
  assert.deepEqual(readProjects(fixture.projectsFile).map((item) => item.id), [
    'initial-id',
    'newer-id'
  ]);
});

test('rechecks and reserves updated projects immediately before applying an import', (t) => {
  const fixture = transferFixture(t);
  const existing = project('existing-id', 'Existing', fixture.folder('existing'));
  writeProjects(fixture.projectsFile, [existing]);
  const preview = previewProjectImport(readProjects(fixture.projectsFile), [
    project('incoming-id', 'Changed', existing.folder)
  ]);
  const beforeApply = fs.readFileSync(fixture.projectsFile, 'utf8');
  const requestedReservations = [];

  assert.throws(
    () => applyProjectImport(fixture.projectsFile, preview, {
      reserveUpdatedProjects: (ids) => {
        requestedReservations.push(ids);
        return false;
      }
    }),
    (error) => error instanceof ProjectTransferError && error.code === 'ACTIVE_IMPORT'
  );
  assert.deepEqual(requestedReservations, [['existing-id']]);
  assert.equal(fs.readFileSync(fixture.projectsFile, 'utf8'), beforeApply);
});
