const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeSearchQuery, projectSearchText } = require('../src/projects/project-search');
const {
  pinnedProjectsFirst,
  readProjects,
  toggleProjectPinned,
  upsertProject
} = require('../src/projects/project-store');
const { readShippedHostSource } = require('./helpers/extension-source');

test('persists pinning without changing the saved project order', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-pinning-'));
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  const firstFolder = path.join(temporaryRoot, 'first');
  const secondFolder = path.join(temporaryRoot, 'second');
  fs.mkdirSync(firstFolder);
  fs.mkdirSync(secondFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const first = upsertProject(projectsFile, {
    folder: firstFolder,
    startCommand: 'npm run dev'
  }).project;
  const second = upsertProject(projectsFile, {
    folder: secondFolder,
    startCommand: 'npm run dev'
  }).project;

  assert.equal(toggleProjectPinned(projectsFile, second.id).pinned, true);
  assert.deepEqual(readProjects(projectsFile).map((project) => project.id), [first.id, second.id]);
  assert.deepEqual(pinnedProjectsFirst(readProjects(projectsFile)).map((project) => project.id), [second.id, first.id]);

  assert.equal(toggleProjectPinned(projectsFile, second.id).pinned, undefined);
  assert.equal(Object.hasOwn(readProjects(projectsFile)[1], 'pinned'), false);
});

test('keeps stable order within pinned and unpinned groups and does not affect search', () => {
  const projects = [
    { id: 'a', name: 'Alpha', folder: '/projects/alpha' },
    { id: 'b', name: 'Beta', folder: '/projects/beta', pinned: true },
    { id: 'c', name: 'Gamma', folder: '/projects/gamma' },
    { id: 'd', name: 'Delta', folder: '/projects/delta', pinned: true }
  ];
  const ordered = pinnedProjectsFirst(projects);

  assert.deepEqual(ordered.map((project) => project.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(
    ordered.filter((project) => projectSearchText(project).includes(normalizeSearchQuery('projects'))).map((project) => project.id),
    ['b', 'd', 'a', 'c']
  );
  assert.deepEqual(
    ordered.filter((project) => projectSearchText(project).includes(normalizeSearchQuery('gamma'))).map((project) => project.id),
    ['c']
  );
});

test('preserves pinning when an existing project is updated', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-pinning-'));
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  const projectFolder = path.join(temporaryRoot, 'project');
  fs.mkdirSync(projectFolder);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const created = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'npm run dev'
  }).project;
  toggleProjectPinned(projectsFile, created.id);

  const updated = upsertProject(projectsFile, {
    folder: projectFolder,
    startCommand: 'pnpm dev'
  }).project;

  assert.equal(updated.pinned, true);
});

test('renders accessible pin controls and restores focus after a row moves', () => {
  const root = path.join(__dirname, '..');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const extension = readShippedHostSource(root);

  assert.match(webview, /data-action="toggle-pin"[^>]*role="menuitem"[^>]*aria-label=/);
  assert.match(webview, /Pinned \$\{projectKindLabel\}: \$\{projectName\}/);
  assert.match(webview, /project\.pinned \? icon\('pinned', 'project-kind-icon pinned-icon'\) : ''/);
  assert.match(webview, /icon\(project\.pinned \? 'pinned' : 'pin', 'menu-icon'\)/);
  assert.match(webview, /'toggle-pin': \(\) => vscode\.postMessage\(\{ type: 'toggleProjectPin'/);
  assert.match(extension, /toggleProjectPin\(id\)[\s\S]*focusTarget = \{ type: 'project-menu', id \}/);
});
