const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { writeProjectDiagnostics } = require('../src/projects/project-diagnostics');
const {
  approveProjectRepairProposal,
  clearProjectRepairProposal,
  createProjectRepairProposal,
  projectConfigurationRevision,
  projectRepairComparison,
  readProjectRepairProposal,
  serviceNameKey,
  __test: { approveProjectRepairProposalLocked }
} = require('../src/projects/project-repair');
const {
  readProjects,
  toggleProjectPinned,
  upsertProject,
  withProjectStoreLock
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

function waitForMarker(marker) {
  const deadline = Date.now() + 3000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(marker)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${marker}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForAnyMarkerSync(markers, timeoutMs = 5000) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = markers.find((marker) => fs.existsSync(marker));
    if (found) {
      return found;
    }
    Atomics.wait(wait, 0, 0, 10);
  }
  throw new Error(`Timed out waiting for one of: ${markers.join(', ')}`);
}

function waitForChild(child, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let exitCode;
    let exitSignal;
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(
        `${label} worker exited with ${code ?? signal}${stderr ? `: ${stderr}` : ''}`
      ));
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } finally {
        const state = child.runlistDiagnostics?.() || 'result/marker state unavailable';
        finish(new Error(
          `Timed out waiting for ${label} worker `
          + `(pid=${child.pid}, exitCode=${exitCode ?? 'none'}, signal=${exitSignal ?? 'none'}, `
          + `${state}, stderr=${stderr || '<empty>'})`
        ));
      }
    }, timeoutMs);
  });
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
  assert.match(proposal.proposalId, /^[0-9a-f-]{36}$/);
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
  const approved = approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId);
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

test('compares service names using trimmed identity keys', () => {
  const comparison = projectRepairComparison({
    name: 'App',
    folder: '/tmp/app',
    startCommand: 'npm start',
    services: [{ name: 'Web', port: 3000 }]
  }, {
    name: 'App',
    folder: '/tmp/app',
    startCommand: 'npm start',
    services: [{ name: ' web ', port: 3001 }]
  });
  const serviceChanges = comparison.filter((item) => item.field.startsWith('Service:'));
  assert.equal(serviceChanges.length, 1);
  assert.equal(serviceChanges[0].change, 'changed');
});

test('uses locale-invariant service identity keys', () => {
  assert.equal(serviceNameKey(' I '), 'i');
  assert.equal(serviceNameKey('İ'), 'i\u0307');
  assert.notEqual(serviceNameKey('İ'), serviceNameKey('i'));
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

test('preserves omitted metadata when a default service name changes case and whitespace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-repair-case-service-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = upsertProject(projectsFile, {
    folder,
    startCommand: 'npm start',
    services: [{
      name: 'Web',
      port: 3000,
      portVariable: 'WEB_PORT',
      url: 'http://localhost:3000/app',
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
    proposal: { services: [{ name: ' web ', port: 3000 }] }
  });

  const expectedService = {
    ...project.services[0],
    name: 'web'
  };
  assert.deepEqual(proposal.proposedProject.services[0], expectedService);

  const approved = approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId);
  assert.deepEqual(approved.services[0], expectedService);
  assert.deepEqual(readProjects(projectsFile).find(({ id }) => id === project.id).services[0], expectedService);
});

test('preserves omitted metadata when a launch-profile service name changes case', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-repair-case-profile-service-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = upsertProject(projectsFile, {
    folder,
    startCommand: 'npm start',
    services: [],
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm test',
      services: [{
        name: 'web',
        port: 4000,
        portVariable: 'TEST_WEB_PORT',
        url: 'http://localhost:4000/tests',
        healthCheck: {
          mode: 'http',
          target: 'http://localhost:4000/health',
          method: 'HEAD',
          expectedStatus: 200,
          timeoutMs: 900,
          retries: 2
        }
      }]
    }],
    selectedLaunchProfileId: 'tests'
  }, { reviewRequired: false }).project;
  const projectRevision = projectConfigurationRevision(project);
  writeProjectDiagnostics(projectsFile, project.id, {
    projectRevision,
    failedAt: 5678,
    launchProfileId: 'tests'
  });

  const proposal = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 5678,
    proposal: { services: [{ name: 'WEB', port: 4000 }] }
  });

  const expectedService = {
    ...project.launchProfiles[0].services[0],
    name: 'WEB'
  };
  assert.deepEqual(proposal.proposedProject.launchProfiles[0].services[0], expectedService);

  const approved = approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId);
  assert.deepEqual(approved.launchProfiles[0].services[0], expectedService);
  assert.deepEqual(
    readProjects(projectsFile).find(({ id }) => id === project.id).launchProfiles[0].services[0],
    expectedService
  );
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
  const proposal = createProjectRepairProposal(projectsFile, {
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

  const approved = approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId);
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

  const proposal = createProjectRepairProposal(projectsFile, {
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
    () => approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId),
    /changed after the failed start/i
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), changed);
  assert.ok(readProjectRepairProposal(projectsFile, project.id));
});

test('rejects approval for a replaced proposal with matching revision and failure time', (t) => {
  const { project, projectRevision, projectsFile } = fixture(t);
  const proposalInput = {
    projectId: project.id,
    projectRevision,
    failedAt: 1234
  };
  const proposalA = createProjectRepairProposal(projectsFile, {
    ...proposalInput,
    proposal: { startCommand: 'npm run first-fix' }
  });
  const proposalB = createProjectRepairProposal(projectsFile, {
    ...proposalInput,
    proposal: { startCommand: 'npm run replacement-fix' }
  });
  const beforeApproval = fs.readFileSync(projectsFile, 'utf8');

  assert.notEqual(proposalA.proposalId, proposalB.proposalId);
  assert.throws(
    () => approveProjectRepairProposal(projectsFile, project.id, proposalA.proposalId),
    /proposal.*replaced|review.*latest|stale/i
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), beforeApproval);
  assert.equal(readProjectRepairProposal(projectsFile, project.id).proposalId, proposalB.proposalId);

  const approved = approveProjectRepairProposal(projectsFile, project.id, proposalB.proposalId);
  assert.equal(approved.startCommand, 'npm run replacement-fix');
});

test('serializes proposal replacement with approval without deleting a newer proposal', async (t) => {
  const { project, projectRevision, projectsFile, root } = fixture(t);
  const proposalA = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run first-fix' }
  });
  const modulePath = path.join(__dirname, '..', 'src', 'projects', 'project-repair.js');
  const approvalReady = path.join(root, 'approval-ready');
  const replacementWaiting = path.join(root, 'replacement-waiting');
  const replacementStarted = path.join(root, 'replacement-started');
  const replacementResult = path.join(root, 'replacement-result.json');
  const replacementSource = `
    const fs = require('node:fs');
    const originalOpen = fs.openSync;
    let signaled = false;
    fs.openSync = function(filePath, flags, ...args) {
      try {
        return originalOpen.call(this, filePath, flags, ...args);
      } catch (error) {
        if (!signaled
          && error.code === 'EEXIST'
          && String(filePath) === \`\${process.argv[2]}.write-lock\`) {
          signaled = true;
          fs.writeFileSync(process.argv[3], 'waiting');
        }
        throw error;
      }
    };
    fs.writeFileSync(process.argv[4], 'started');
    const { createProjectRepairProposal } = require(process.argv[1]);
    try {
      const proposal = createProjectRepairProposal(process.argv[2], {
        projectId: process.argv[5],
        projectRevision: process.argv[6],
        failedAt: Number(process.argv[7]),
        proposal: { startCommand: 'npm run replacement-fix' }
      });
      fs.writeFileSync(process.argv[8], JSON.stringify({ ok: true, proposalId: proposal.proposalId }));
    } catch (error) {
      fs.writeFileSync(process.argv[8], JSON.stringify({ ok: false, error: error.message }));
    }
  `;
  let replacementWorker;
  let replacementOutcome;
  try {
    const approvalPromise = Promise.resolve().then(() => withProjectStoreLock(
      projectsFile,
      () => approveProjectRepairProposalLocked(
        projectsFile,
        project.id,
        proposalA.proposalId,
        {
          afterProposalRead: () => {
            fs.writeFileSync(approvalReady, 'ready');
            replacementWorker = spawn(process.execPath, [
              '-e', replacementSource, modulePath, projectsFile, replacementWaiting,
              replacementStarted, project.id, projectRevision, '1234', replacementResult
            ], { stdio: ['ignore', 'ignore', 'pipe'] });
            replacementWorker.runlistDiagnostics = () => [
              `approval-ready=${fs.existsSync(approvalReady)}`,
              `replacement-started=${fs.existsSync(replacementStarted)}`,
              `replacement-waiting=${fs.existsSync(replacementWaiting)}`,
              `replacement-result=${fs.existsSync(replacementResult)}`
            ].join(', ');
            waitForAnyMarkerSync([replacementWaiting, replacementResult]);
          }
        }
      )
    ));
    const approved = await approvalPromise;
    assert.equal(approved.startCommand, 'npm run first-fix');
    await waitForChild(replacementWorker, 'replacement');
    replacementOutcome = JSON.parse(fs.readFileSync(replacementResult, 'utf8'));
  } finally {
    if (replacementWorker && replacementWorker.exitCode === null) {
      replacementWorker.kill();
    }
  }

  const finalProject = readProjects(projectsFile).find(({ id }) => id === project.id);
  const finalProposal = readProjectRepairProposal(projectsFile, project.id);
  assert.equal(finalProject.startCommand, 'npm run first-fix');
  if (replacementOutcome.ok) {
    assert.equal(finalProposal?.proposalId, replacementOutcome.proposalId);
    assert.notEqual(
      replacementOutcome.ok && finalProposal === undefined,
      true,
      'approval must not clear a replacement proposal that completed successfully'
    );
  } else {
    assert.match(replacementOutcome.error, /stale|project changed|diagnostic context/i);
    assert.equal(finalProposal, undefined);
  }
});

test('refuses a legacy proposal without an immutable review identity', (t) => {
  const { project, projectRevision, projectsFile } = fixture(t);
  const proposal = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run legacy-fix' }
  });
  const proposalFile = fs.readdirSync(path.join(path.dirname(projectsFile), 'repair-proposals'))
    .map((name) => path.join(path.dirname(projectsFile), 'repair-proposals', name))
    .find((candidate) => JSON.parse(fs.readFileSync(candidate, 'utf8')).projectId === project.id);
  const legacy = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
  delete legacy.proposalId;
  fs.writeFileSync(proposalFile, `${JSON.stringify(legacy)}\n`);
  const beforeApproval = fs.readFileSync(projectsFile, 'utf8');

  assert.throws(
    () => approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId),
    /refresh.*proposal|review identity|legacy/i
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), beforeApproval);
});

test('revision covers env and related fields so approve rejects after env change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-repair-env-revision-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  const composePath = path.join(root, 'docker-compose.yml');
  fs.mkdirSync(folder);
  fs.writeFileSync(composePath, 'services: {}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const base = {
    name: 'App',
    folder,
    startCommand: 'npm run dev',
    services: [{ name: 'web', port: 3000 }],
    env: { API_TOKEN: 'proposal-time-secret' },
    envFile: '.env',
    requiredEnvKeys: ['API_TOKEN'],
    composePath,
    localHostname: 'app'
  };
  const withEnvChanged = {
    ...base,
    env: { API_TOKEN: 'later-secret' }
  };
  assert.notEqual(
    projectConfigurationRevision(base),
    projectConfigurationRevision(withEnvChanged)
  );
  assert.notEqual(
    projectConfigurationRevision(base),
    projectConfigurationRevision({ ...base, envFile: '.env.local' })
  );
  assert.notEqual(
    projectConfigurationRevision(base),
    projectConfigurationRevision({ ...base, requiredEnvKeys: ['API_TOKEN', 'DB_URL'] })
  );
  assert.notEqual(
    projectConfigurationRevision(base),
    projectConfigurationRevision({ ...base, composePath: path.join(root, 'compose.yml') })
  );
  assert.notEqual(
    projectConfigurationRevision(base),
    projectConfigurationRevision({ ...base, localHostname: 'other' })
  );
  assert.equal(
    projectConfigurationRevision({ ...base, env: { Z: '1', A: '2' } }),
    projectConfigurationRevision({ ...base, env: { A: '2', Z: '1' } })
  );

  const project = upsertProject(projectsFile, base, { reviewRequired: false }).project;
  const projectRevision = projectConfigurationRevision(project);
  writeProjectDiagnostics(projectsFile, project.id, {
    summary: { message: 'Start failed' },
    failedAt: 1234,
    projectRevision
  });
  const proposal = createProjectRepairProposal(projectsFile, {
    projectId: project.id,
    projectRevision,
    failedAt: 1234,
    proposal: { startCommand: 'npm run fixed' }
  });

  upsertProject(projectsFile, {
    ...project,
    env: { API_TOKEN: 'later-secret' }
  }, { reviewRequired: false });
  const afterEnvChange = fs.readFileSync(projectsFile, 'utf8');

  assert.throws(
    () => approveProjectRepairProposal(projectsFile, project.id, proposal.proposalId),
    /changed after the failed start/i
  );
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), afterEnvChange);
  assert.deepEqual(readProjects(projectsFile)[0].env, { API_TOKEN: 'later-secret' });
});
