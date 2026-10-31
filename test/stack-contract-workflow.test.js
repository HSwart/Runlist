const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readProjects,
  writeProjects
} = require('../src/projects/project-store');
const {
  serializeStackContract
} = require('../src/projects/stack-contract');
const {
  prepareStackContractLoad,
  commitStackContractLoad,
  runStackContractExportWorkflow
} = require('../src/projects/project-transfer');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stack-wf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = fs.realpathSync(root);
  fs.mkdirSync(path.join(workspaceRoot, 'apps', 'api'), { recursive: true });
  const projectsFile = path.join(workspaceRoot, 'storage', 'projects.json');
  fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
  writeProjects(projectsFile, []);
  return { workspaceRoot, projectsFile };
}

test('prepare/commit load applies only after commit and marks review required', async (t) => {
  const { workspaceRoot, projectsFile } = fixture(t);
  fs.writeFileSync(path.join(workspaceRoot, 'runlist.json'), serializeStackContract({
    projects: [
      {
        id: 'x',
        name: 'Web',
        folder: workspaceRoot,
        startCommand: 'npm run dev',
        services: [{ name: 'web', port: 3000 }]
      }
    ],
    groups: []
  }, { workspaceRoot }));

  const prepared = prepareStackContractLoad({ projectsFile, workspaceRoot });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.preview.changeCount, 1);
  assert.equal(readProjects(projectsFile).length, 0);

  await commitStackContractLoad({
    parsed: prepared.parsed,
    preview: prepared.preview,
    projectsFile,
    workspaceRoot
  });
  const projects = readProjects(projectsFile);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Web');
  assert.equal(projects[0].reviewRequired, true);
});

test('prepare dismisses malformed files without writing', (t) => {
  const { workspaceRoot, projectsFile } = fixture(t);
  fs.writeFileSync(path.join(workspaceRoot, 'runlist.json'), '{"schemaVersion":1,"projects":[{"name":"Bad","folder":"../x","startCommand":"x","services":[]}]}');
  const prepared = prepareStackContractLoad({ projectsFile, workspaceRoot });
  assert.equal(prepared.status, 'error');
  assert.match(prepared.message, /workspace|relative|escape|inside/i);
  assert.equal(readProjects(projectsFile).length, 0);
});

test('export workflow writes relative contract and confirms overwrite', async (t) => {
  const { workspaceRoot, projectsFile } = fixture(t);
  const saved = {
    id: 'web-id',
    name: 'Web',
    folder: workspaceRoot,
    startCommand: 'npm run dev',
    services: [{ name: 'web', port: 3000 }],
    reviewRequired: false
  };
  writeProjects(projectsFile, [saved]);
  const target = path.join(workspaceRoot, 'runlist.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"projects":[],"groups":[]}');

  const declined = await runStackContractExportWorkflow({
    projectsFile,
    workspaceRoot,
    window: {
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined
    }
  });
  assert.equal(declined.status, 'cancelled');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).projects.length, 0);

  const exported = await runStackContractExportWorkflow({
    projectsFile,
    workspaceRoot,
    window: {
      showWarningMessage: async (_message, _opts, confirm) => confirm,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined
    }
  });
  assert.equal(exported.status, 'exported');
  const document = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.projects[0].folder, '.');
  assert.equal(document.projects[0].id, undefined);
});

test('export then prepare shows no spurious churn for identical setups', async (t) => {
  const { workspaceRoot, projectsFile } = fixture(t);
  writeProjects(projectsFile, [{
    id: 'web-id',
    name: 'Web',
    folder: workspaceRoot,
    startCommand: 'npm run dev',
    services: [{ name: 'web', port: 3000 }],
    reviewRequired: false
  }]);
  await runStackContractExportWorkflow({
    projectsFile,
    workspaceRoot,
    window: {
      showWarningMessage: async (_m, _o, confirm) => confirm,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined
    }
  });
  const prepared = prepareStackContractLoad({ projectsFile, workspaceRoot });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.preview.changeCount, 0);
  assert.equal(readProjects(projectsFile)[0].reviewRequired, false);
});
