'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyProjectImport,
  exportProjectDocument,
  parseImportFile,
  previewProjectImport,
  syncImportedRunGroups
} = require('../src/projects/project-transfer');
const { writeProjects, readProjects, upsertRunGroup, readRunGroups } = require('../src/projects/project-store');
const { stopRunGroup } = require('../src/groups/run-groups');
const { workspaceImportFolderKey } = require('../src/projects/workspace-import');

function project(id, name, folder, extra = {}) {
  return {
    id,
    name,
    folder,
    startCommand: 'npm start',
    services: [],
    reviewRequired: false,
    ...extra
  };
}

test('previewProjectImport resolves dependsOn references inside the import file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-import-deps-'));
  const apiFolder = path.join(root, 'api');
  const dbFolder = path.join(root, 'db');
  fs.mkdirSync(apiFolder, { recursive: true });
  fs.mkdirSync(dbFolder, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const imported = [
    project('api', 'API', apiFolder, { dependsOn: ['db'] }),
    project('db', 'Database', dbFolder)
  ];
  Object.defineProperty(imported, 'schemaVersion', { value: 11, enumerable: false });

  const preview = previewProjectImport([], imported);
  assert.equal(preview.entries[0].status, 'add');
  assert.equal(preview.entries[1].status, 'add');
  assert.deepEqual(preview.entries[0].project.dependsOn, ['db']);
});

test('exportProjectDocument includes run groups when requested', () => {
  const first = project('first', 'First', '/workspace/first');
  const second = project('second', 'Second', '/workspace/second');
  const document = JSON.parse(exportProjectDocument([first, second], {
    groups: [{
      id: 'stack',
      name: 'Stack',
      projectIds: ['first', 'second'],
      startMode: 'sequential'
    }]
  }));
  assert.deepEqual(document.groups, [{
    id: 'stack',
    name: 'Stack',
    projectIds: ['first', 'second'],
    startMode: 'sequential'
  }]);
});

test('export and import round-trip preserves run groups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-export-groups-'));
  const sourceFile = path.join(root, 'source.json');
  const targetFile = path.join(root, 'target.json');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = project('first', 'First', path.join(root, 'first'));
  const second = project('second', 'Second', path.join(root, 'second'));
  fs.mkdirSync(first.folder, { recursive: true });
  fs.mkdirSync(second.folder, { recursive: true });
  writeProjects(sourceFile, [first, second]);
  upsertRunGroup(sourceFile, {
    name: 'Stack',
    projectIds: ['first', 'second'],
    startMode: 'sequential'
  });

  const exported = parseImportFile(exportProjectDocument([first, second], {
    groups: readRunGroups(sourceFile)
  }));
  assert.equal(exported.groups.length, 1);
  assert.equal(exported.groups[0].name, 'Stack');

  const preview = previewProjectImport([], exported.projects);
  applyProjectImport(targetFile, preview);
  syncImportedRunGroups(targetFile, preview.nextProjects, exported.groups, exported.projects);
  const groups = readRunGroups(targetFile);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].projectIds, ['first', 'second']);
});

test('writeProjects rejects dependency cycles', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-cycle-'));
  const projectsFile = path.join(root, 'projects.json');
  const apiFolder = path.join(root, 'api');
  const dbFolder = path.join(root, 'db');
  fs.mkdirSync(apiFolder, { recursive: true });
  fs.mkdirSync(dbFolder, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => writeProjects(projectsFile, [
      project('api', 'API', apiFolder, { dependsOn: ['db'] }),
      project('db', 'Database', dbFolder, { dependsOn: ['api'] })
    ]),
    /Dependency cycle detected/
  );
});

test('stopRunGroup stops members in reverse dependency order', async () => {
  const calls = [];
  const projects = [
    project('api', 'API', '/workspace/api', { dependsOn: ['db'] }),
    project('db', 'Database', '/workspace/db')
  ];
  const result = await stopRunGroup({
    id: 'stack',
    name: 'Stack',
    projectIds: ['api', 'db']
  }, {
    coordinator: { acquire: () => true, release: () => {} },
    projects,
    isOwned: () => true,
    stopProject: async (id) => {
      calls.push(id);
      return true;
    },
    waitUntilStopped: async () => true
  });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(calls, ['api', 'db']);
});

test('stopRunGroup reports skipped non-owned members', async () => {
  const result = await stopRunGroup({
    id: 'daily',
    name: 'Daily',
    projectIds: ['first', 'second']
  }, {
    coordinator: { acquire: () => true, release: () => {} },
    projects: [
      project('first', 'First', '/workspace/first'),
      project('second', 'Second', '/workspace/second')
    ],
    isOwned: (id) => id === 'first',
    stopProject: async () => true,
    waitUntilStopped: async () => true
  });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.stoppedProjectIds, ['first']);
  assert.deepEqual(result.skippedProjectIds, ['second']);
});

test('workspaceImportFolderKey is case-sensitive on Linux', (t) => {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-import-key-'));
  const upper = path.join(root, 'App');
  const lower = path.join(root, 'app');
  fs.mkdirSync(upper);
  fs.mkdirSync(lower);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.notEqual(workspaceImportFolderKey(upper), workspaceImportFolderKey(lower));
});

test('applyProjectFilter keeps the stack attention chip in the summary slot', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'media', 'main.js'),
    'utf8'
  );
  assert.match(
    source,
    /attentionSlot\.innerHTML = `\$\{stackAttentionSummaryHtml\(state\.stackContractAttention\)\}/
  );
});

test('setLogSearchQuery updates results without a full render', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
    'utf8'
  );
  const setQuery = source.slice(
    source.indexOf('setLogSearchQuery(query)'),
    source.indexOf('async beginComposeImport')
  );
  assert.match(setQuery, /sendLogSearchUpdate\(\)/);
  assert.doesNotMatch(setQuery, /this\.render\(\)/);
});

test('imported run groups resolve members by folder when ids differ', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-import-group-folder-'));
  const projectsFile = path.join(root, 'target.json');
  const folder = path.join(root, 'api');
  fs.mkdirSync(folder, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const local = project('local-id', 'API', folder);
  writeProjects(projectsFile, [local]);
  const imported = [
    project('export-id', 'API', folder)
  ];
  Object.defineProperty(imported, 'schemaVersion', { value: 11, enumerable: false });
  const groups = [{
    id: 'stack',
    name: 'Stack',
    projectIds: ['export-id'],
    startMode: 'sequential'
  }];
  const preview = previewProjectImport(readProjects(projectsFile), imported);
  applyProjectImport(projectsFile, preview);
  syncImportedRunGroups(projectsFile, preview.nextProjects, groups, imported);
  const savedGroups = readRunGroups(projectsFile);
  assert.equal(savedGroups.length, 1);
  assert.deepEqual(savedGroups[0].projectIds, ['local-id']);
});
