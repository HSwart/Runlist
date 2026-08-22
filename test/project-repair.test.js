const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeProjectDiagnostics } = require('../src/projects/project-diagnostics');
const {
  approveProjectRepairProposal,
  clearProjectRepairProposal,
  createProjectRepairProposal,
  projectConfigurationRevision,
  projectRepairComparison,
  readProjectRepairProposal
} = require('../src/projects/project-repair');
const {
  readProjects,
  toggleProjectPinned,
  upsertProject
} = require('../src/projects/project-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-repair-'));
  const projectsFile = path.join(root, 'projects.json');
  const projectFolder = path.join(root, 'app');
  const otherFolder = path.join(root, 'other');
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(otherFolder);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = upsertProject(projectsFile, {
    name: 'App',
    folder: projectFolder,
    startCommand: 'npm run dev',
    stopCommand: 'npm run stop',
    services: [
      { name: 'web', port: 3000, url: 'http://localhost:3000/app' },
      { name: 'api', port: 4000 }
    ]
  }).project;
  const other = upsertProject(projectsFile, {
    name: 'Other',
    folder: otherFolder,
    startCommand: 'npm run other',
    services: []
  }).project;
  const projectRevision = projectConfigurationRevision(project);
  writeProjectDiagnostics(projectsFile, project.id, {
    summary: { message: 'Start failed' },
    failedAt: 1234,
    projectRevision
  });
  return { other, otherFolder, project, projectFolder, projectRevision, projectsFile, root };
}

test('binds a normalized repair proposal to one failed project revision', (t) => {
  const { project, projectRevision, projectsFile } = fixture(t);
  const before = fs.readFileSync(projectsFile, 'utf8');

  const proposal = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run dev -- --host' }
  });

  assert.equal(fs.readFileSync(projectsFile, 'utf8'), before);
  assert.equal(proposal.projectId, project.id);
  assert.equal(proposal.projectRevision, projectRevision);
  assert.equal(proposal.failedAt, 1234);
  assert.equal(proposal.proposedProject.startCommand, 'npm run dev -- --host');
  assert.equal(proposal.proposedProject.stopCommand, project.stopCommand);
  assert.deepEqual(readProjectRepairProposal(projectsFile, project.id), proposal);
});

test('accepts the full stored project identifier length for repair requests', (t) => {
  const { projectRevision, projectsFile } = fixture(t);
  const input = {
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run fixed' }
  };

  assert.throws(
    () => createProjectRepairProposal(projectsFile, {
      ...input,
      projectId: 'x'.repeat(256)
    }),
    /selected Runlist project was not found/i
  );
  assert.throws(
    () => createProjectRepairProposal(projectsFile, {
      ...input,
      projectId: 'x'.repeat(257)
    }),
    /projectId must identify/i
  );
});

test('targets command and service repairs to the launch profile that failed', (t) => {
  const { project, projectsFile } = fixture(t);
  const profiledProject = upsertProject(projectsFile, {
    ...project,
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm test',
      services: [{ name: 'test-api', port: 4311 }]
    }],
    selectedLaunchProfileId: 'tests'
  }, { reviewRequired: false }).project;
  const projectRevision = projectConfigurationRevision(profiledProject);
  writeProjectDiagnostics(projectsFile, project.id, {
    summary: { message: 'Tests failed' },
    failedAt: 5678,
    projectRevision,
    launchProfileId: 'tests'
  });

  const proposal = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 5678,
    proposal: {
      startCommand: 'npm run test:fixed',
      services: [{ name: 'test-api', port: 4312 }]
    }
  });

  assert.equal(proposal.proposedProject.startCommand, project.startCommand);
  assert.deepEqual(proposal.proposedProject.services, project.services);
  assert.equal(proposal.proposedProject.launchProfiles[0].startCommand, 'npm run test:fixed');
  assert.deepEqual(proposal.proposedProject.launchProfiles[0].services, [{
    name: 'test-api', port: 4312
  }]);
  const comparison = projectRepairComparison(profiledProject, proposal.proposedProject);
  assert.ok(comparison.some((item) => (
    item.field === 'Profile: Tests - start command' && item.change === 'changed'
  )));
  assert.ok(comparison.some((item) => (
    item.field === 'Profile: Tests - Service: test-api' && item.proposed.includes(':4312')
  )));

  const selectedDefault = upsertProject(projectsFile, {
    ...profiledProject,
    selectedLaunchProfileId: 'default'
  }, { reviewRequired: false }).project;
  assert.equal(projectConfigurationRevision(selectedDefault), projectRevision);
  const approved = approveProjectRepairProposal(projectsFile, project.id);
  assert.equal(approved.startCommand, project.startCommand);
  assert.deepEqual(approved.services, project.services);
  assert.equal(approved.selectedLaunchProfileId, undefined);
  assert.equal(approved.launchProfiles[0].startCommand, 'npm run test:fixed');
  assert.deepEqual(approved.launchProfiles[0].services, [{
    name: 'test-api', port: 4312
  }]);
});

test('includes health checks in revisions and complete service comparisons', () => {
  const base = {
    name: 'App',
    folder: '/tmp/app',
    startCommand: 'npm start',
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }]
  };
  const configured = {
    ...base,
    services: [{
      name: 'web',
      port: 3000,
      healthCheck: {
        mode: 'http',
        target: '/health',
        method: 'GET',
        expectedStatus: 204,
        timeoutMs: 1200,
        retries: 1
      }
    }]
  };

  assert.notEqual(projectConfigurationRevision(base), projectConfigurationRevision(configured));
  const serviceChange = projectRepairComparison(base, configured)
    .find((item) => item.field === 'Service: web');
  assert.equal(serviceChange.change, 'changed');
  assert.match(serviceChange.proposed, /health: GET \/health, status 204, 1200 ms, 1 retry/);
});

test('preserves omitted service metadata in a repair that changes a port', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-repair-service-metadata-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    folder,
    startCommand: 'npm start',
    services: [{
      name: 'web',
      port: 3000,
      portVariable: 'PORT',
      healthCheck: {
        mode: 'http',
        target: 'http://localhost:3000/health',
        method: 'GET',
        expectedStatus: 204,
        timeoutMs: 1200,
        retries: 1
      }
    }]
  }, { reviewRequired: false }).project;
  const projectRevision = projectConfigurationRevision(project);
  writeProjectDiagnostics(projectsFile, project.id, {
    projectRevision,
    failedAt: 1234
  });

  const proposal = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { services: [{ name: 'web', port: 3001 }] }
  });

  assert.deepEqual(proposal.proposedProject.services[0], {
    ...project.services[0],
    port: 3001,
    healthCheck: {
      ...project.services[0].healthCheck,
      target: 'http://localhost:3001/health'
    }
  });
});

test('renders field-level added, removed, changed, and unchanged values', () => {
  const comparison = projectRepairComparison({
    id: 'app',
    name: 'App',
    folder: 'C:\\app',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: [
      { name: 'web', port: 3000, url: 'http://localhost:3000/old' },
      { name: 'api', port: 4000 }
    ]
  }, {
    id: 'app',
    name: 'App',
    folder: 'C:\\app',
    startCommand: 'npm run dev',
    services: [
      {
        name: 'web',
        port: 3001,
        portVariable: 'PORT',
        url: 'http://localhost:3001/new'
      },
      { name: 'worker', port: 5000 }
    ]
  });

  assert.ok(comparison.some((item) => item.field === 'Name' && item.change === 'unchanged'));
  assert.ok(comparison.some((item) => item.field === 'Start command' && item.change === 'changed'));
  assert.ok(comparison.some((item) => item.field === 'Stop command' && item.change === 'removed'));
  assert.ok(comparison.some((item) => item.field === 'Service: api' && item.change === 'removed'));
  assert.ok(comparison.some((item) => item.field === 'Service: worker' && item.change === 'added'));
  assert.ok(comparison.some((item) => (
    item.field === 'Service: web'
      && item.change === 'changed'
      && item.current.includes(':3000')
      && item.proposed.includes(':3001')
      && item.proposed.includes('temporary via PORT')
  )));
});

test('rejection clears only the pending proposal and preserves setup bytes', (t) => {
  const { project, projectRevision, projectsFile } = fixture(t);
  const before = fs.readFileSync(projectsFile, 'utf8');
  createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run dev -- --host' }
  });

  assert.equal(clearProjectRepairProposal(projectsFile, project.id), true);
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), before);
  assert.equal(readProjectRepairProposal(projectsFile, project.id), undefined);
});

test('approval updates only the reviewed setup and clears the proposal', (t) => {
  const { other, project, projectRevision, projectsFile } = fixture(t);
  createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: {
      startCommand: 'npm run dev -- --host',
      stopCommand: '',
      services: [{ name: 'web', port: 3100 }]
    }
  });

  toggleProjectPinned(projectsFile, project.id);

  const approved = approveProjectRepairProposal(projectsFile, project.id);
  const projects = readProjects(projectsFile);
  assert.equal(approved.startCommand, 'npm run dev -- --host');
  assert.equal(Object.hasOwn(approved, 'stopCommand'), false);
  assert.deepEqual(approved.services, [{ name: 'web', port: 3100 }]);
  assert.equal(approved.pinned, true);
  assert.deepEqual(projects.find((candidate) => candidate.id === other.id), other);
  assert.equal(readProjectRepairProposal(projectsFile, project.id), undefined);
});

test('rejects stale, cross-project, and malformed proposals without changing setup', (t) => {
  const { other, project, projectRevision, projectsFile } = fixture(t);
  const before = fs.readFileSync(projectsFile, 'utf8');

  assert.throws(() => createProjectRepairProposal(projectsFile, {
    projectId: other.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'wrong project' }
  }), /failed start|revision/i);
  assert.throws(() => createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { unsupported: true }
  }), /unsupported/i);
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), before);

  createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run fixed' }
  });
  upsertProject(projectsFile, {
    ...project,
    startCommand: 'npm run changed elsewhere'
  }, { reviewRequired: false });
  const changed = fs.readFileSync(projectsFile, 'utf8');
  assert.throws(
    () => approveProjectRepairProposal(projectsFile, project.id),
    /changed after the failed start/i
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), changed);
  assert.ok(readProjectRepairProposal(projectsFile, project.id));
});
