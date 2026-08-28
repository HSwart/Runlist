const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeProjectDiagnostics, readProjectDiagnostics, clearProjectDiagnostics } = require('../src/projects/project-diagnostics');
const {
  createProjectRepairProposal,
  projectConfigurationRevision,
  readProjectRepairProposal
} = require('../src/projects/project-repair');
const { projectFormValues } = require('../src/projects/project-form');
const {
  readProjects,
  removeProject,
  upsertProject,
  writeProjects
} = require('../src/projects/project-store');
const { ProcessOwnershipStore } = require('../src/lifecycle/project-process');

function loadRunlistProvider(messages) {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    env: {
      remoteName: undefined,
      clipboard: {
        async writeText(text) {
          messages.push({ type: 'clipboard', text });
        }
      }
    },
    commands: {
      async executeCommand(...args) {
        messages.push({ type: 'command', args });
      }
    },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage(message) {
        messages.push({ type: 'error', message });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message) {
        messages.push({ type: 'warning', message });
        return Promise.resolve(undefined);
      },
      showInformationMessage() {
        return Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    providerModule._compile(source, providerPath);
    return providerModule.exports.RunlistViewProvider;
  } finally {
    Module._load = originalLoad;
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-diagnostics-lifecycle-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'App',
    folder,
    startCommand: 'npm run dev',
    services: []
  }, { reviewRequired: false }).project;
  const messages = [];
  const Provider = loadRunlistProvider(messages);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  const view = {
    webview: {
      cspSource: 'none',
      asWebviewUri: (uri) => uri,
      html: '',
      postMessage: () => Promise.resolve(true)
    }
  };
  provider.view = view;
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { messages, project, projectsFile, provider, root, view };
}

function seedFailure({ project, projectsFile, provider }) {
  const projectRevision = projectConfigurationRevision(project);
  const failedAt = 1234;
  writeProjectDiagnostics(projectsFile, project.id, {
    failedAt,
    output: 'old failure output',
    projectRevision,
    summary: { title: 'Start failed', message: 'old failure' }
  });
  const proposal = createProjectRepairProposal(projectsFile, {
    failedAt,
    projectId: project.id,
    projectRevision,
    proposal: { startCommand: 'npm run repaired' }
  });
  provider.projectOutputs.set(project.id, 'old failure output');
  provider.projectFailureDetails.set(project.id, {
    detail: 'old failure',
    projectRevision
  });
  provider.projectFailureSummaries.set(project.id, {
    title: 'Start failed',
    message: 'old failure'
  });
  provider.projectTimelineFailures.set(project.id, {
    detail: 'old failure',
    failedAt,
    launchedAt: 1,
    projectRevision
  });
  provider.projectAttemptMetadata.set(project.id, { launchedAt: 1 });
  provider.readinessWarnings.add(project.id);
  provider.startReadinessDeadlines.set(project.id, Date.now() + 1000);
  return { failedAt, projectRevision, proposal };
}

function setupEdit(provider, project) {
  provider.mode = 'edit';
  provider.selectedProjectId = project.id;
  provider.formProjectSnapshot = JSON.parse(JSON.stringify(project));
}

function renderedState(view) {
  const match = view.webview.html.match(/window\.runlistState = ([\s\S]*?);<\/script>/);
  assert.ok(match, 'rendered webview state is present');
  return JSON.parse(match[1]);
}

function useStableProcessOwnership({ projectsFile, provider }) {
  const hostIdentity = 'test-host:diagnostics-lifecycle';
  provider.processOwnership = new ProcessOwnershipStore(
    path.join(path.dirname(projectsFile), 'process-ownership'),
    {
      hostIdentity,
      isProcessAlive: () => true,
      readHostProcessIdentity: () => hostIdentity
    }
  );
}

test('cross-window deletion clears expanded preview state and exits diagnosis with valid focus', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile, root, view } = fixtureData;
  seedFailure(fixtureData);
  const remainingFolder = path.join(root, 'remaining');
  fs.mkdirSync(remainingFolder);
  const remaining = upsertProject(projectsFile, {
    name: 'Remaining',
    folder: remainingFolder,
    startCommand: 'npm run dev',
    services: []
  }, { reviewRequired: false }).project;
  const previewPort = 3000;
  const previewUrl = `http://127.0.0.1:${previewPort}`;
  writeProjects(projectsFile, [
    {
      ...project,
      services: [{ name: 'Web', port: previewPort, url: previewUrl }]
    },
    remaining
  ]);
  provider.projectStatuses.set(project.id, 'running');
  provider.projectServiceUrls.set(project.id, [{ port: previewPort, url: previewUrl }]);
  provider.render();
  provider.toggleProjectPreview(project.id);
  assert.equal(provider.expandedPreviewProjectId, project.id);
  assert.equal(provider.expandedPreviewServicePort, previewPort);
  provider.showProjectOutput(project.id);
  assert.equal(provider.mode, 'output');
  provider.showProjectDiagnosis(project.id);
  assert.equal(provider.mode, 'diagnosis');
  assert.equal(renderedState(view).diagnosis.projectId, project.id);

  assert.equal(removeProject(projectsFile, project.id), true);
  provider.handleProjectStoreChange();
  const immediateState = renderedState(view);
  assert.equal(provider.expandedPreviewProjectId, undefined);
  assert.equal(provider.expandedPreviewServicePort, undefined);
  assert.deepEqual(immediateState.focusTarget, { type: 'project-control', id: remaining.id });
  assert.notDeepEqual(immediateState.focusTarget, { type: 'project-control', id: project.id });
  await provider.statusRefreshPromise;

  const state = renderedState(view);
  assert.equal(provider.mode, 'list');
  assert.equal(provider.selectedProjectId, undefined);
  assert.equal(provider.diagnosisProjectIncarnation, undefined);
  assert.equal(state.mode, 'list');
  assert.equal(state.diagnosis, undefined);
  assert.deepEqual(state.focusTarget, { type: 'project-control', id: remaining.id });
  assert.match(state.routeNotice, /project is no longer available.*diagnosis was closed/i);
});

test('same-ID recreation cannot inherit a deleted diagnosis, while ordinary rerenders preserve it', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile, view } = fixtureData;
  seedFailure(fixtureData);
  provider.render();
  provider.showProjectDiagnosis(project.id);
  const diagnosisIncarnation = provider.diagnosisProjectIncarnation;

  provider.handleProjectStoreChange();
  await provider.statusRefreshPromise;
  assert.equal(provider.mode, 'diagnosis');
  assert.equal(provider.diagnosisProjectIncarnation, diagnosisIncarnation);
  assert.equal(renderedState(view).diagnosis.projectId, project.id);

  assert.equal(removeProject(projectsFile, project.id), true);
  provider.handleProjectStoreChange();
  await provider.statusRefreshPromise;
  assert.equal(provider.mode, 'list');

  writeProjects(projectsFile, [project]);
  provider.handleProjectStoreChange();
  await provider.statusRefreshPromise;
  const recreatedState = renderedState(view);
  assert.equal(provider.mode, 'list');
  assert.equal(provider.selectedProjectId, undefined);
  assert.equal(recreatedState.diagnosis, undefined);
  assert.notEqual(provider.projectIncarnations.get(project.id), diagnosisIncarnation);
  assert.match(recreatedState.routeNotice, /diagnosis was closed/i);
});

test('list model exposes canAskAgent only while retained diagnostics exist', (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile, view } = fixtureData;
  seedFailure(fixtureData);
  provider.render();

  const withDiagnostics = renderedState(view).projects.find((item) => item.id === project.id);
  assert.equal(withDiagnostics.canAskAgent, true);
  assert.equal(Object.hasOwn(withDiagnostics, 'retainedOutput'), false);
  assert.equal(Object.hasOwn(withDiagnostics, 'outputTruncated'), false);

  clearProjectDiagnostics(projectsFile, project.id);
  provider.render();
  const withoutDiagnostics = renderedState(view).projects.find((item) => item.id === project.id);
  assert.equal(withoutDiagnostics.canAskAgent, false);
  assert.equal(readProjectDiagnostics(projectsFile, project.id), undefined);
});

test('cross-window deletion of the last project focuses the working Add route', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile, view } = fixtureData;
  seedFailure(fixtureData);
  provider.render();
  provider.showProjectDiagnosis(project.id);

  assert.equal(removeProject(projectsFile, project.id), true);
  provider.handleProjectStoreChange();
  await provider.statusRefreshPromise;

  const state = renderedState(view);
  assert.equal(state.mode, 'list');
  assert.equal(state.focusTarget, undefined);
  assert.equal(state.projects.length, 0);
});

test('successful manual save invalidates old failure state and repair proposal', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile } = fixtureData;
  const { projectRevision, proposal } = seedFailure(fixtureData);
  setupEdit(provider, project);

  await provider.saveProject({
    ...projectFormValues(project),
    startCommand: 'npm run repaired'
  });

  assert.notEqual(projectConfigurationRevision(readProjects(projectsFile)[0]), projectRevision);
  assert.equal(readProjectDiagnostics(projectsFile, project.id), undefined);
  assert.equal(readProjectRepairProposal(projectsFile, project.id), undefined);
  assert.equal(provider.projectOutputs.has(project.id), false);
  assert.equal(provider.projectFailureDetails.has(project.id), false);
  assert.equal(provider.projectFailureSummaries.has(project.id), false);
  assert.equal(provider.projectTimelineFailures.has(project.id), false);
  assert.equal(provider.projectAttemptMetadata.has(project.id), false);
  assert.equal(provider.readinessWarnings.has(project.id), false);
  assert.equal(provider.startReadinessDeadlines.has(project.id), false);
  assert.equal(proposal.projectRevision, projectRevision);
});

test('late output and exit from an old setup revision cannot recreate diagnostics', async (t) => {
  const fixtureData = fixture(t);
  const { messages, project, provider, projectsFile } = fixtureData;
  const { projectRevision } = seedFailure(fixtureData);
  setupEdit(provider, project);
  await provider.saveProject({
    ...projectFormValues(project),
    startCommand: 'npm run repaired'
  });
  const errorsBeforeLateExit = messages.filter(({ type }) => type === 'error').length;

  provider.addProjectOutput(project.id, 'late old stdout', projectRevision);
  provider.showStartFailure(project, {
    detail: 'late old exit',
    projectRevision
  });

  assert.equal(readProjectDiagnostics(projectsFile, project.id), undefined);
  assert.equal(provider.projectOutputs.has(project.id), false);
  assert.equal(provider.projectFailureDetails.has(project.id), false);
  assert.equal(provider.projectFailureSummaries.has(project.id), false);
  assert.equal(
    messages.filter(({ type }) => type === 'error').length,
    errorsBeforeLateExit
  );
});

test('retains failed-start diagnostics when exited-process cleanup remains uncertain', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile } = fixtureData;
  const projectRevision = projectConfigurationRevision(project);
  const child = {
    // A live PID makes Windows descendant cleanup deterministically uncertain
    // when the required launch identity is unavailable.
    pid: process.pid,
    exitCode: 7,
    signalCode: null,
    runlistIdentity: Promise.resolve(undefined)
  };
  provider.processOwnership.reserve(project.id);
  provider.processOwnership.setProcess(project.id, child.pid, {
    identityRequired: true,
    state: 'running'
  });
  provider.processes.set(project.id, child);
  provider.managedProjectIds.add(project.id);
  provider.projectStatuses.set(project.id, 'running');
  provider.projectOutputs.set(project.id, 'controlled failure output');
  provider.projectAttemptMetadata.set(project.id, {
    launchedAt: Date.now() - 10,
    projectRevision
  });

  await provider.handleProjectProcessExit({
    child,
    code: 7,
    hasServices: false,
    id: project.id,
    launchProject: project,
    project,
    savedProjectRevision: projectRevision,
    signal: null
  });

  const diagnostics = readProjectDiagnostics(projectsFile, project.id);
  assert.equal(provider.getProjectStatus(project.id), 'ownership-lost');
  assert.match(diagnostics?.failureSummary?.message || '', /controlled failure output/i);
});

test('successful save preserves newer diagnostics, proposal, and runtime state', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile } = fixtureData;
  useStableProcessOwnership(fixtureData);
  const { projectRevision: obsoleteRevision } = seedFailure(fixtureData);
  const newerRevision = projectConfigurationRevision({
    ...project,
    startCommand: 'npm run repaired'
  });
  const newerFailedAt = 5678;
  writeProjectDiagnostics(projectsFile, project.id, {
    failedAt: newerFailedAt,
    output: 'newer failure output',
    projectRevision: newerRevision,
    summary: { title: 'Newer start failed', message: 'newer failure' }
  });
  const proposalPath = fs.readdirSync(path.join(path.dirname(projectsFile), 'repair-proposals'))
    .map((name) => path.join(path.dirname(projectsFile), 'repair-proposals', name))
    .find((candidate) => JSON.parse(fs.readFileSync(candidate, 'utf8')).projectId === project.id);
  const newerProposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
  newerProposal.projectRevision = newerRevision;
  newerProposal.failedAt = newerFailedAt;
  fs.writeFileSync(proposalPath, `${JSON.stringify(newerProposal)}\n`);

  const newerDetails = { detail: 'newer failure', projectRevision: newerRevision };
  const newerSummary = { title: 'Newer start failed', message: 'newer failure' };
  const newerTimeline = {
    detail: 'newer failure',
    failedAt: newerFailedAt,
    launchedAt: 2,
    projectRevision: newerRevision
  };
  const newerAttempt = { launchedAt: 2, projectRevision: newerRevision };
  provider.projectOutputs.set(project.id, 'newer failure output');
  provider.projectFailureDetails.set(project.id, newerDetails);
  provider.projectFailureSummaries.set(project.id, newerSummary);
  provider.projectTimelineFailures.set(project.id, newerTimeline);
  provider.projectAttemptMetadata.set(project.id, newerAttempt);
  provider.readinessWarnings.add(project.id);
  provider.startReadinessDeadlines.set(project.id, 987654);
  provider.projectStatuses.set(project.id, 'running');
  provider.managedProjectIds.add(project.id);
  provider.projectRuntime.set(project.id, { processActive: true });
  assert.equal(provider.processOwnership.reserve(project.id), undefined);

  const expectedDiagnostic = readProjectDiagnostics(projectsFile, project.id);
  const expectedProposal = readProjectRepairProposal(projectsFile, project.id);
  const expectedOwnership = provider.processOwnership.snapshot().get(project.id);
  setupEdit(provider, project);
  await provider.saveProject({
    ...projectFormValues(project),
    startCommand: 'npm run repaired'
  });

  assert.notEqual(obsoleteRevision, newerRevision);
  assert.deepEqual(readProjectDiagnostics(projectsFile, project.id), expectedDiagnostic);
  assert.deepEqual(readProjectRepairProposal(projectsFile, project.id), expectedProposal);
  assert.deepEqual(provider.projectOutputs.get(project.id), 'newer failure output');
  assert.deepEqual(provider.projectFailureDetails.get(project.id), newerDetails);
  assert.deepEqual(provider.projectFailureSummaries.get(project.id), newerSummary);
  assert.deepEqual(provider.projectTimelineFailures.get(project.id), newerTimeline);
  assert.deepEqual(provider.projectAttemptMetadata.get(project.id), newerAttempt);
  assert.equal(provider.readinessWarnings.has(project.id), true);
  assert.equal(provider.startReadinessDeadlines.get(project.id), 987654);
  assert.equal(provider.projectStatuses.get(project.id), 'running');
  assert.equal(provider.managedProjectIds.has(project.id), true);
  assert.deepEqual(provider.projectRuntime.get(project.id), { processActive: true });
  assert.deepEqual(provider.processOwnership.snapshot().get(project.id), expectedOwnership);
  provider.processOwnership.release(project.id);
});

test('successful repair approval invalidates old failure state and diagnosis UI', async (t) => {
  const fixtureData = fixture(t);
  const { project, provider, projectsFile, view } = fixtureData;
  useStableProcessOwnership(fixtureData);
  const { proposal } = seedFailure(fixtureData);
  provider.mode = 'diagnosis';
  provider.selectedProjectId = project.id;

  assert.equal(await provider.approveProjectRepair(proposal.proposalId), true);

  assert.equal(readProjectRepairProposal(projectsFile, project.id), undefined);
  assert.equal(readProjectDiagnostics(projectsFile, project.id), undefined);
  assert.equal(provider.projectOutputs.has(project.id), false);
  assert.equal(provider.projectFailureDetails.has(project.id), false);
  assert.equal(provider.projectFailureSummaries.has(project.id), false);
  assert.equal(provider.projectTimelineFailures.has(project.id), false);
  assert.equal(provider.readinessWarnings.has(project.id), false);
  provider.render();
  assert.doesNotMatch(view.webview.html, /"diagnosis":\{/);
});

test('Ask your agent copies a diagnosis request when no agent is connected', async (t) => {
  const fixtureData = fixture(t);
  const { messages, project, provider } = fixtureData;
  seedFailure(fixtureData);
  const posted = [];
  provider.view.webview.postMessage = (message) => {
    posted.push(message);
    return Promise.resolve(true);
  };
  provider.selectedProjectId = project.id;

  await provider.copyDiagnosisRequest();

  assert.equal(posted.some((item) => item.type === 'diagnosisRequestCopied'), true);
  assert.equal(messages.some((item) => item.type === 'clipboard' && /projectId/.test(item.text)), true);
  assert.equal(messages.some((item) => item.type === 'command'), false);
  assert.equal(provider.mode, 'list');
});

test('Ask your agent invokes VS Code chat when an agent is connected', async (t) => {
  const fixtureData = fixture(t);
  const { messages, project, provider } = fixtureData;
  seedFailure(fixtureData);
  const posted = [];
  provider.view.webview.postMessage = (message) => {
    posted.push(message);
    return Promise.resolve(true);
  };
  provider.agentConnections.copilot = { status: 'success', message: 'ready' };

  await provider.askAgent(project.id);

  const command = messages.find((item) => item.type === 'command');
  assert.ok(command);
  assert.equal(command.args[0], 'workbench.action.chat.open');
  assert.match(command.args[1].query, /projectId "/);
  assert.match(command.args[1].query, /runlist_get_project_diagnostics/);
  assert.doesNotMatch(command.args[1].query, /old failure output/);
  assert.equal(posted.some((item) => item.type === 'diagnosisHandoffSent'), true);
  assert.equal(messages.some((item) => item.type === 'clipboard'), false);
  assert.equal(provider.mode, 'list');
});

test('Ask your agent opens the diagnosis screen when chat invoke is unavailable', async (t) => {
  const fixtureData = fixture(t);
  const { messages, project, provider, view } = fixtureData;
  seedFailure(fixtureData);
  provider.agentConnections.claude = { status: 'success', message: 'ready' };
  messages.length = 0;
  provider.sendDiagnosisHandoff = async () => false;

  await provider.askAgent(project.id);

  assert.equal(provider.mode, 'diagnosis');
  assert.equal(renderedState(view).diagnosis.projectId, project.id);
  assert.equal(messages.some((item) => item.type === 'clipboard'), false);
});

test('failed start does not send diagnosis to an agent automatically', (t) => {
  const fixtureData = fixture(t);
  const { messages, project, provider } = fixtureData;
  seedFailure(fixtureData);
  provider.agentConnections.codex = { status: 'success', message: 'ready' };
  messages.length = 0;
  provider.persistStartFailure(project, { code: 1 }, {
    title: 'Start failed',
    message: 'boom'
  });
  assert.equal(messages.some((item) => item.type === 'command'), false);
  assert.equal(messages.some((item) => item.type === 'clipboard'), false);
});
