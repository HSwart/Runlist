const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeProjectDiagnostics } = require('../src/projects/project-diagnostics');
const { projectConfigurationRevision } = require('../src/projects/project-repair');
const {
  MAX_LISTED_PROJECTS,
  buildListedProjects,
  buildProjectStatus,
  ownershipRecordPath,
  projectControllableInThisWindow,
  readObservedLifecycleState,
  windowLifecycleSupported
} = require('../src/projects/mcp-project-status');

test('lists bounded project metadata without start commands or secrets', () => {
  const listed = buildListedProjects([
    {
      id: 'app-1',
      name: 'App',
      folder: '/tmp/app',
      reviewRequired: false,
      startCommand: 'API_KEY=secret npm start',
      env: { API_KEY: 'secret' },
      services: [{ name: 'web', port: 3000, url: 'https://example.test/?token=secret' }]
    }
  ], { windowLifecycleSupported: true, platform: 'linux' });

  assert.equal(listed.projects.length, 1);
  assert.equal(listed.truncated, false);
  assert.equal(listed.projects[0].controllableInThisWindow, true);
  assert.equal(listed.projects[0].observedLifecycleState, 'stopped');
  assert.match(listed.projects[0].services[0].url, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(listed), /API_KEY=secret|startCommand|"env"/);
});

test('marks review-required and remote-blocked projects as not controllable', () => {
  assert.equal(projectControllableInThisWindow({
    reviewRequired: true,
    folder: '/tmp/app'
  }, { platform: 'linux', windowLifecycleSupported: true }), false);
  assert.equal(projectControllableInThisWindow({
    reviewRequired: false,
    folder: '/tmp/app'
  }, { platform: 'linux', windowLifecycleSupported: false }), false);
  assert.equal(projectControllableInThisWindow({
    reviewRequired: false,
    folder: '\\\\wsl$\\Ubuntu\\home\\me\\app'
  }, { platform: 'win32', windowLifecycleSupported: true }), false);
});

test('reads ownership state from the shared file without requiring a live process', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectId = 'app-1';
  fs.writeFileSync(ownershipRecordPath(root, projectId), JSON.stringify({
    projectId,
    hostPid: 1,
    token: 'token',
    state: 'starting'
  }));

  assert.equal(readObservedLifecycleState(root, projectId), 'starting');
  assert.equal(readObservedLifecycleState(root, 'missing'), 'stopped');
});

test('truncates long project lists', () => {
  const projects = Array.from({ length: MAX_LISTED_PROJECTS + 3 }, (_, index) => ({
    id: `app-${index}`,
    name: `App ${index}`,
    folder: `/tmp/app-${index}`,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 + index }]
  }));
  const listed = buildListedProjects(projects, { windowLifecycleSupported: true, platform: 'linux' });
  assert.equal(listed.projects.length, MAX_LISTED_PROJECTS);
  assert.equal(listed.truncated, true);
});

test('status includes retained failure summary and revision without raw output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-status-diag-'));
  const projectsFile = path.join(root, 'projects.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = {
    id: 'app-1',
    name: 'App',
    folder: '/tmp/app',
    startCommand: 'npm start',
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }]
  };
  const revision = projectConfigurationRevision(project);
  writeProjectDiagnostics(projectsFile, project.id, {
    summary: { title: 'Start failed', message: 'API_KEY=secret-value' },
    output: 'TOKEN=output-secret',
    failedAt: 42,
    projectRevision: revision
  });

  const status = buildProjectStatus(project, {
    projectsFile,
    platform: 'linux',
    windowLifecycleSupported: true
  });
  assert.equal(status.diagnosticsAvailable, true);
  assert.equal(status.repairAvailable, false);
  assert.equal(status.failedAt, 42);
  assert.equal(status.projectRevision, revision);
  assert.match(status.failureSummary.message, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(status), /secret-value|output-secret|retainedOutput/);
});

test('windowLifecycleSupported treats only an explicit 0 as blocked', () => {
  assert.equal(windowLifecycleSupported({}), true);
  assert.equal(windowLifecycleSupported({ RUNLIST_WINDOW_LIFECYCLE_SUPPORTED: '1' }), true);
  assert.equal(windowLifecycleSupported({ RUNLIST_WINDOW_LIFECYCLE_SUPPORTED: '0' }), false);
});
