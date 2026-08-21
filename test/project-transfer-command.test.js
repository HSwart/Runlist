const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readProjects, writeProjects } = require('../project-store');
const {
  exportProjectDocument,
  runProjectTransferWorkflow
} = require('../project-transfer');

function workflowFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-transfer-command-'));
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

test('cancelling the native transfer choice writes nothing', async (t) => {
  const fixture = workflowFixture(t);
  writeProjects(fixture.projectsFile, []);
  let writes = 0;

  const result = await runProjectTransferWorkflow({
    projectsFile: fixture.projectsFile,
    window: { showQuickPick: async () => undefined },
    workspace: { fs: { writeFile: async () => { writes += 1; } } }
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(writes, 0);
});

test('exports all saved setups through native save UI', async (t) => {
  const fixture = workflowFixture(t);
  const saved = project('saved-id', 'Saved', fixture.folder('saved'));
  writeProjects(fixture.projectsFile, [saved]);
  const exportUri = { fsPath: path.join(fixture.root, 'export.json') };
  let written;
  const information = [];

  const result = await runProjectTransferWorkflow({
    projectsFile: fixture.projectsFile,
    window: {
      showQuickPick: async (items) => items.find((item) => item.action === 'export-all'),
      showSaveDialog: async () => exportUri,
      showInformationMessage: async (message) => { information.push(message); }
    },
    workspace: {
      fs: {
        writeFile: async (uri, contents) => {
          assert.equal(uri, exportUri);
          written = Buffer.from(contents).toString('utf8');
        }
      }
    }
  });

  assert.equal(result.status, 'exported');
  assert.deepEqual(JSON.parse(written), JSON.parse(exportProjectDocument([saved])));
  assert.match(information[0], /Exported 1 project setup/i);
});

test('previews and applies confirmed imports while keeping changes blocked for review', async (t) => {
  const fixture = workflowFixture(t);
  const updateFolder = fixture.folder('update');
  const addFolder = fixture.folder('add');
  const current = project('current-id', 'Current', updateFolder);
  writeProjects(fixture.projectsFile, [current]);
  const imported = [
    project('incoming-update', 'Updated', updateFolder),
    project('added-id', 'Added', addFolder),
    project('invalid-id', 'Invalid', path.join(fixture.root, 'missing'))
  ];
  const importUri = { fsPath: path.join(fixture.root, 'import.json') };
  let previewDetail = '';
  let importedNotifications = 0;
  let rendered = 0;
  let releasedReservations = 0;
  const reservedUpdates = [];

  const result = await runProjectTransferWorkflow({
    projectsFile: fixture.projectsFile,
    window: {
      showQuickPick: async (items) => items.find((item) => item.action === 'import'),
      showOpenDialog: async () => [importUri],
      showWarningMessage: async (message, options, confirm) => {
        assert.match(message, /Import 2 project setups/i);
        previewDetail = options.detail;
        return confirm;
      },
      showInformationMessage: async () => { importedNotifications += 1; },
      showErrorMessage: async (message) => assert.fail(message)
    },
    workspace: {
      fs: {
        readFile: async (uri) => {
          assert.equal(uri, importUri);
          return Buffer.from(exportProjectDocument(imported));
        }
      }
    },
    reserveUpdatedProjects: (ids) => {
      reservedUpdates.push(ids);
      return () => { releasedReservations += 1; };
    },
    onImported: () => { rendered += 1; }
  });

  assert.equal(result.status, 'imported');
  assert.match(previewDetail, /Update \(1\)/);
  assert.match(previewDetail, /Add \(1\)/);
  assert.match(previewDetail, /Invalid \(1\)/);
  assert.equal(importedNotifications, 1);
  assert.equal(rendered, 1);
  assert.deepEqual(reservedUpdates, [['current-id']]);
  assert.equal(releasedReservations, 1);
  assert.deepEqual(readProjects(fixture.projectsFile).map((item) => ({
    id: item.id,
    name: item.name,
    reviewRequired: item.reviewRequired
  })), [
    { id: 'current-id', name: 'Updated', reviewRequired: true },
    { id: 'added-id', name: 'Added', reviewRequired: true }
  ]);
});

test('cancelling import confirmation preserves the exact store', async (t) => {
  const fixture = workflowFixture(t);
  const current = project('current-id', 'Current', fixture.folder('current'));
  const added = project('added-id', 'Added', fixture.folder('added'));
  writeProjects(fixture.projectsFile, [current]);
  const before = fs.readFileSync(fixture.projectsFile, 'utf8');

  const result = await runProjectTransferWorkflow({
    projectsFile: fixture.projectsFile,
    window: {
      showQuickPick: async (items) => items.find((item) => item.action === 'import'),
      showOpenDialog: async () => [{ fsPath: path.join(fixture.root, 'import.json') }],
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message) => assert.fail(message)
    },
    workspace: {
      fs: { readFile: async () => Buffer.from(exportProjectDocument([added])) }
    }
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(fs.readFileSync(fixture.projectsFile, 'utf8'), before);
});
