const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { safeHttpUrl } = require('./external-url');
const {
  claudeBundledCliPaths,
  codexBundledCliPath,
  registerWithClaude,
  registerWithCodex
} = require('./agent-registration');
const {
  agentSkillStatus,
  installAgentSkill
} = require('./skill-installation');
const {
  projectStatus,
  reachableServiceUrls,
  runningAppProjectIds,
  serviceHttpStatus,
  serviceReadinessDetails,
  serviceReadinessTimedOut,
  servicePortStatus,
  serviceTimelineStages,
  stoppableProjectIds
} = require('./project-status');
const {
  copyProjectPath: writeProjectPathToClipboard,
  openProjectInNewWindow,
  openProjectTerminal,
  projectFolderIsAccessible
} = require('./project-navigation');
const { previewFrameSource, projectPreviewService } = require('./preview-security');
const { OwnedProcessMetrics } = require('./process-metrics');
const { RuntimePulseHistory } = require('./runtime-pulse');
const {
  appendStartupHistory,
  clearStartupHistory,
  readStartupHistory,
  startupHistoryEntry
} = require('./startup-history');
const {
  canUseCurrentWorkspace,
  selectCurrentWorkspaceFolder
} = require('./project-workspace');
const {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  handoffProjectSafely,
  ProcessOwnershipStore,
  projectProcessSpawnOptions,
  restartProjectSafely,
  startExitFailed,
  terminateTrackedProcess
} = require('./project-process');
const {
  occupiedPortsBelongToProject,
  occupiedPortConflict,
  PortReservationStore
} = require('./port-gate');
const {
  projectFormChanged,
  projectFormServices,
  projectServicesChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
} = require('./project-form');
const {
  appendProjectOutput,
  createOutputUpdateScheduler,
  formatProjectOutput,
  listenToProjectOutput,
  projectOutputPeek,
  sanitizeProjectOutput,
  startFailureSummary
} = require('./project-output');
const {
  clearProjectDiagnostics,
  readProjectDiagnostics,
  writeProjectDiagnostics
} = require('./project-diagnostics');
const { projectSearchText } = require('./project-search');
const {
  initializeProjectStore,
  pinnedProjectsFirst,
  readProjects,
  removeProject,
  toggleProjectPinned,
  upsertProject
} = require('./project-store');

const STORAGE_KEY = 'runlist.projects';
const START_READINESS_TIMEOUT_MS = 30000;
const STATUS_POLL_INTERVAL_MS = 2000;
const RESOURCE_SAMPLE_INTERVAL_MS = 5000;
const CUSTOM_STOP_TIMEOUT_MS = 15000;
const CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS = 20000;
const REMOTE_STOP_TIMEOUT_MS = STATUS_POLL_INTERVAL_MS
  + CUSTOM_STOP_TIMEOUT_MS
  + CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS
  + 1000;

class RunlistViewProvider {
  constructor(context, projectsFile, serverPath) {
    this.context = context;
    this.projectsFile = projectsFile;
    this.serverPath = serverPath;
    this.view = undefined;
    this.mode = 'list';
    this.searchQuery = '';
    this.draft = {};
    this.formBaseline = {};
    this.formErrors = {};
    this.focusTarget = undefined;
    this.lastFocusTarget = undefined;
    this.returnFocus = undefined;
    this.selectedProjectId = undefined;
    this.expandedPreviewProjectId = undefined;
    this.expandedPreviewServicePort = undefined;
    this.processes = new Map();
    this.ownedProcessMetrics = new OwnedProcessMetrics();
    this.projectMetrics = new Map();
    this.runtimePulseHistory = new RuntimePulseHistory();
    this.resourceSampleTimer = undefined;
    this.resourceSampleProjectId = undefined;
    this.resourceSampleGeneration = 0;
    this.projectOutputs = new Map();
    this.projectFailureSummaries = new Map();
    this.projectFailureDetails = new Map();
    this.outputUpdateScheduler = createOutputUpdateScheduler((id) => this.sendProjectOutput(id));
    this.managedProjectIds = new Set();
    this.portReservations = new PortReservationStore(
      path.join(path.dirname(projectsFile), 'port-reservations')
    );
    this.processOwnership = new ProcessOwnershipStore(
      path.join(path.dirname(projectsFile), 'process-ownership')
    );
    this.startAttempts = new Map();
    this.projectPortConflicts = new Map();
    this.projectOpenPorts = new Map();
    this.projectRespondingPorts = new Map();
    this.projectServiceUrls = new Map();
    this.projectWebPorts = new Map();
    this.projectStatuses = new Map();
    this.projectRuntime = new Map();
    this.projectAttemptMetadata = new Map();
    this.projectTimelineFailures = new Map();
    this.startReadinessDeadlines = new Map();
    this.readinessWarnings = new Set();
    this.restartingProjectIds = new Set();
    this.handoffProjectIds = new Set();
    this.stoppingProjectIds = new Set();
    this.remoteStopRequests = new Map();
    this.statusRefreshInFlight = false;
    this.statusRevision = 0;
    this.skillSourceDirectory = path.join(context.extensionUri.fsPath, 'skills', 'runlist');
    this.agentConnections = Object.fromEntries(
      ['copilot', 'codex', 'claude'].map((agent) => [agent, initialAgentConnection(agent)])
    );
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    view.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.render();
  }

  async showAddProject(returnFocus) {
    if (!await this.confirmDiscardProjectChanges()) {
      return;
    }
    this.mode = 'add';
    this.draft = {};
    this.formBaseline = projectFormValues({});
    this.formErrors = {};
    this.focusTarget = { type: 'field', id: 'project-name' };
    this.returnFocus = returnFocus || this.defaultListFocusTarget();
    this.selectedProjectId = undefined;
    this.view?.show?.(true);
    this.render();
  }

  async showAgentSetup() {
    if (!await this.confirmDiscardProjectChanges()) {
      return;
    }
    this.mode = 'agents';
    this.draft = {};
    this.focusTarget = { type: 'action', action: 'close-screen' };
    this.returnFocus = this.defaultListFocusTarget();
    this.selectedProjectId = undefined;
    this.view?.show?.(true);
    this.render();
  }

  get projects() {
    return pinnedProjectsFirst(readProjects(this.projectsFile));
  }

  defaultListFocusTarget() {
    return this.projects.length
      ? { type: 'field', id: 'project-search' }
      : { type: 'action', action: 'show-add' };
  }

  getProjectStatus(id) {
    if (this.stoppingProjectIds.has(id)) {
      return 'stopping';
    }
    if (this.startAttempts.has(id)) {
      return 'starting';
    }
    return this.projectStatuses.get(id)
      || (this.processes.has(id) ? 'running' : 'stopped');
  }

  isProjectRunning(id) {
    return ['running', 'active'].includes(this.getProjectStatus(id));
  }

  renderProjectList() {
    if (this.mode === 'list') {
      this.render();
    }
  }

  startStatusMonitoring() {
    this.refreshProjectStatuses();
    const timer = setInterval(() => this.refreshProjectStatuses(), STATUS_POLL_INTERVAL_MS);
    return { dispose: () => clearInterval(timer) };
  }

  async refreshProjectStatuses() {
    if (this.statusRefreshInFlight) {
      return;
    }

    this.statusRefreshInFlight = true;
    const revision = this.statusRevision;
    try {
      for (const id of this.processOwnership.consumeStopRequests()) {
        const project = this.projects.find((candidate) => candidate.id === id);
        void this.stopProject(id, project || { id, name: 'this project' });
      }
      const now = Date.now();
      const projects = this.projects;
      const portRuntime = this.portReservations.snapshot();
      const processRuntime = this.processOwnership.snapshot();
      const handoffOwnerIds = new Set([...processRuntime]
        .filter(([, ownership]) => ownership.ownerAvailable
          && ownership.processActive
          && ownership.state !== 'stopping')
        .map(([id]) => id));
      for (const [id, request] of [...this.remoteStopRequests]) {
        if (processRuntime.get(id)?.state !== 'stopping') {
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
        } else if (now - request.requestedAt >= REMOTE_STOP_TIMEOUT_MS) {
          this.processOwnership.cancelStopRequest(id);
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
          vscode.window.showErrorMessage(
            `Could not confirm that ${request.projectName} stopped: its launching VS Code window did not respond. Runlist left the process ownership unchanged.`
          );
        }
      }
      const sharedRuntime = new Map([
        ...portRuntime,
        ...[...processRuntime].map(([id, ownership]) => [id, ownership.state])
      ]);
      for (const id of [...this.managedProjectIds]) {
        if (!sharedRuntime.has(id)) {
          this.managedProjectIds.delete(id);
          this.portReservations.release(id);
          this.startReadinessDeadlines.delete(id);
        }
      }
      const managedProjectIds = new Set([
        ...this.managedProjectIds,
        ...sharedRuntime.keys()
      ]);
      const checks = await Promise.all(projects.map(async (project) => {
        const hasServices = Boolean(project.services?.length);
        const portStatus = hasServices
          ? await servicePortStatus(project.services)
          : { allOpen: false, anyOpen: false, openPorts: [] };
        const [httpStatus, reachableUrls] = hasServices
          ? await Promise.all([
              serviceHttpStatus(project.services, portStatus.openPorts, {
                resolveUrl: (url) => this.externalServiceUrl(url)
              }),
              reachableServiceUrls(project.services, portStatus.openPorts, {
                resolveUrl: (url) => this.externalServiceUrl(url)
              })
            ])
          : [{ allResponding: true, respondingPorts: [], unresponsivePorts: [], webPorts: [] }, []];
        const ownership = processRuntime.get(project.id);
        const sharedState = sharedRuntime.get(project.id);
        const readinessDeadline = ownership?.readinessDeadline
          || this.startReadinessDeadlines.get(project.id);
        const allReady = portStatus.allOpen && httpStatus.allResponding;
        const readinessTimedOut = hasServices
          && managedProjectIds.has(project.id)
          && (sharedState === 'running'
            || serviceReadinessTimedOut(readinessDeadline, allReady, now));
        const conflict = occupiedPortConflict({
          project,
          projects,
          managedProjectIds: handoffOwnerIds,
          openPorts: portStatus.openPorts
        });
        const status = projectStatus({
          allOpen: portStatus.allOpen,
          ambiguousConflict: conflict?.kind === 'ambiguous',
          anyOpen: portStatus.anyOpen,
          hasServices,
          knownConflict: conflict?.kind === 'managed',
          managed: managedProjectIds.has(project.id),
          httpUnresponsive: httpStatus.unresponsivePorts.length > 0,
          processActive: this.processes.has(project.id) || ownership?.processActive,
          readinessTimedOut,
          stopping: this.stoppingProjectIds.has(project.id) || sharedState === 'stopping',
        });
        return [
          project.id,
          status,
          portConflictSummary(
            conflict,
            processRuntime,
            this.portReservations.conflicts(project),
            portStatus.openPorts
          ),
          portStatus.openPorts,
          httpStatus.respondingPorts,
          httpStatus.webPorts,
          reachableUrls,
          serviceReadinessDetails(
            project.services,
            portStatus.openPorts,
            httpStatus.respondingPorts,
            httpStatus.webPorts
          )
        ];
      }));

      if (revision !== this.statusRevision) {
        return;
      }

      const projectsById = new Map(projects.map((project) => [project.id, project]));
      for (const [id, status, , , , , , readinessDetails] of checks) {
        if (status === 'stopped') {
          this.managedProjectIds.delete(id);
          this.startReadinessDeadlines.delete(id);
          this.readinessWarnings.delete(id);
        } else if (status === 'running') {
          this.startReadinessDeadlines.delete(id);
          this.readinessWarnings.delete(id);
          if (this.managedProjectIds.has(id)) {
            const readyAt = processRuntime.get(id)?.readyAt || Date.now();
            this.recordStartupOutcome(id, 'ready', readyAt);
            this.processOwnership.setState(id, 'running', {
              readyAt
            });
            this.portReservations.setState(id, 'running');
          }
        } else if (['not-ready', 'not-responding'].includes(status)
          && this.managedProjectIds.has(id)) {
          this.recordStartupOutcome(id, 'timed-out');
          this.processOwnership.setState(id, status);
          this.portReservations.setState(id, status);
          this.notifyServiceNotReady(projectsById.get(id), status, readinessDetails);
        }
      }

      const nextStatuses = new Map(checks.map(([id, status]) => [id, status]));
      const nextConflicts = new Map(checks
        .filter(([, , conflict]) => conflict)
        .map(([id, , conflict]) => [id, conflict]));
      const nextOpenPorts = new Map(checks
        .map(([id, , , openPorts]) => [id, openPorts]));
      const nextRespondingPorts = new Map(checks
        .map(([id, , , , respondingPorts]) => [id, respondingPorts]));
      const nextWebPorts = new Map(checks
        .map(([id, , , , , webPorts]) => [id, webPorts]));
      const nextServiceUrls = new Map(checks
        .map(([id, , , , , , serviceUrls]) => [id, serviceUrls]));
      const nextRuntime = this.processOwnership.snapshot();
      const runtimeChanged = nextRuntime.size !== this.projectRuntime.size
        || [...nextRuntime].some(([id, runtime]) => {
          const previous = this.projectRuntime.get(id);
          return runtime.launchedAt !== previous?.launchedAt
            || runtime.readyAt !== previous?.readyAt;
        });
      const changed = nextStatuses.size !== this.projectStatuses.size
        || [...nextStatuses].some(([id, status]) => this.projectStatuses.get(id) !== status)
        || runtimeChanged
        || portConflictMapsDiffer(nextConflicts, this.projectPortConflicts)
        || [...nextOpenPorts]
          .some(([id, openPorts]) => String(this.projectOpenPorts.get(id)) !== String(openPorts))
        || [...nextRespondingPorts]
          .some(([id, ports]) => String(this.projectRespondingPorts.get(id)) !== String(ports))
        || [...nextWebPorts]
          .some(([id, ports]) => String(this.projectWebPorts.get(id)) !== String(ports))
        || [...nextServiceUrls]
          .some(([id, urls]) => JSON.stringify(this.projectServiceUrls.get(id)) !== JSON.stringify(urls));
      this.projectStatuses = nextStatuses;
      this.projectPortConflicts = nextConflicts;
      this.projectOpenPorts = nextOpenPorts;
      this.projectRespondingPorts = nextRespondingPorts;
      this.projectServiceUrls = nextServiceUrls;
      this.projectWebPorts = nextWebPorts;
      this.projectRuntime = nextRuntime;
      for (const [id, metadata] of this.projectAttemptMetadata) {
        const readyAt = this.projectRuntime.get(id)?.readyAt;
        if (Number.isFinite(readyAt)) {
          metadata.readyAt = readyAt;
        }
      }
      if (changed) {
        this.renderProjectList();
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not refresh Runlist status: ${error.message}`);
    } finally {
      this.statusRefreshInFlight = false;
    }
  }

  async handleMessage(message) {
    switch (message.type) {
      case 'showAdd':
        await this.showAddProject({ type: 'action', action: 'show-add' });
        break;
      case 'closeScreen':
        await this.closeScreen(message.draft);
        break;
      case 'showEdit':
        this.showEditProject(message.id);
        break;
      case 'showOutput':
        this.showProjectOutput(message.id);
        break;
      case 'copyOutput':
        await this.copyProjectOutput();
        break;
      case 'openOutputUrl':
        await this.openOutputUrl(message.url);
        break;
      case 'showDiagnosis':
        this.showProjectDiagnosis(message.id);
        break;
      case 'copyDiagnosisRequest':
        await this.copyDiagnosisRequest();
        break;
      case 'showAgentSetup':
        await this.showAgentSetup();
        break;
      case 'pickFolder':
        await this.pickFolder(message.draft);
        break;
      case 'useCurrentWorkspace':
        await this.useCurrentWorkspace(message.draft);
        break;
      case 'saveProject':
        await this.saveProject(message.project);
        break;
      case 'startProject':
        await this.startProject(message.id);
        break;
      case 'stopProject':
        await this.stopProject(message.id);
        break;
      case 'restartProject':
        await this.restartProject(message.id);
        break;
      case 'handoffProject':
        await this.handoffProject(message.id);
        break;
      case 'stopAllProjects':
        this.stopAllProjects();
        break;
      case 'openProject':
        await this.openProject(message.id);
        break;
      case 'openProjectFolder':
        await this.openProjectFolder(message.id);
        break;
      case 'openProjectTerminal':
        await this.openProjectTerminal(message.id);
        break;
      case 'copyProjectPath':
        await this.copyProjectPath(message.id);
        break;
      case 'copyServiceUrl':
        await this.copyServiceUrl(message.id, Number(message.port));
        break;
      case 'toggleProjectPreview':
        this.toggleProjectPreview(message.id);
        break;
      case 'toggleProjectPin':
        this.toggleProjectPin(message.id);
        break;
      case 'setSearchQuery':
        this.searchQuery = String(message.query || '');
        break;
      case 'setFocusTarget':
        this.lastFocusTarget = validFocusTarget(message.target);
        break;
      case 'updateDraft':
        if (['add', 'edit'].includes(this.mode)) {
          this.draft = projectFormValues(message.draft);
        }
        break;
      case 'deleteProject':
        await this.deleteProject(message.id);
        break;
      case 'registerAgent':
        await this.registerAgent(message.agent);
        break;
    }
  }

  async registerAgent(agent) {
    const registrations = {
      copilot: {
        label: 'GitHub Copilot',
        success: 'Skill installed. Use /runlist in Copilot CLI, or ask Copilot agent mode to set up this project.'
      },
      claude: {
        label: 'Claude Code',
        register: registerWithClaude,
        success: 'Connection and skill are ready. Use /runlist. Restart Claude Code if it was already open and does not detect the skill.'
      },
      codex: {
        label: 'Codex',
        register: registerWithCodex,
        success: 'Connection and skill are ready. Restart Codex, then use $runlist.'
      }
    };
    const registration = registrations[agent];
    if (!registration || this.agentConnections[agent].status === 'loading') {
      return;
    }

    this.agentConnections[agent] = {
      status: 'loading',
      message: `Setting up ${registration.label}…`
    };
    this.render();

    try {
      if (registration.register) {
        await registration.register({
          bundledCliPaths: installedClaudeCliPaths(),
          bundledCliPath: installedCodexCliPath(),
          environment: process.env,
          platform: process.platform,
          projectsFile: this.projectsFile,
          runtimePath: process.execPath,
          serverPath: this.serverPath
        });
      }
      installAgentSkill({
        agent,
        environment: process.env,
        platform: process.platform,
        sourceDirectory: this.skillSourceDirectory
      });
      this.agentConnections[agent] = {
        status: 'success',
        message: registration.success
      };
    } catch (error) {
      this.agentConnections[agent] = {
        status: 'error',
        message: registrationErrorMessage(registration.label, error)
      };
    }
    this.render();
  }

  showEditProject(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    this.mode = 'edit';
    this.selectedProjectId = id;
    this.draft = { ...project };
    this.formBaseline = projectFormValues(project);
    this.formErrors = {};
    this.focusTarget = { type: 'field', id: project.reviewRequired ? 'start-command' : 'project-name' };
    this.returnFocus = { type: 'project-menu', id };
    this.render();
  }

  showProjectOutput(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    this.mode = 'output';
    this.selectedProjectId = id;
    this.focusTarget = { type: 'action', action: 'close-screen' };
    this.returnFocus = { type: 'project-menu', id };
    this.render();
  }

  showProjectDiagnosis(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project || !readProjectDiagnostics(this.projectsFile, id)) {
      return;
    }

    this.mode = 'diagnosis';
    this.selectedProjectId = id;
    this.focusTarget = { type: 'action', action: 'copy-diagnosis-request' };
    this.returnFocus = { type: 'project-menu', id };
    this.render();
  }

  async closeScreen(draft) {
    if (draft && ['add', 'edit'].includes(this.mode)) {
      this.draft = projectFormValues(draft);
    }
    if (!await this.confirmDiscardProjectChanges()) {
      return;
    }

    const returnFocus = this.returnFocus;
    this.mode = 'list';
    this.draft = {};
    this.formBaseline = {};
    this.formErrors = {};
    this.selectedProjectId = undefined;
    this.returnFocus = undefined;
    this.focusTarget = returnFocus;
    this.render();
  }

  async confirmDiscardProjectChanges() {
    if (!['add', 'edit'].includes(this.mode)
      || !projectFormChanged(this.draft, this.formBaseline)) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      'Discard unsaved project changes?',
      {
        modal: true,
        detail: 'Your project has not been saved. Leaving this screen will discard the changes.'
      },
      'Discard changes'
    );
    return choice === 'Discard changes';
  }

  addProjectOutput(id, chunk) {
    const output = appendProjectOutput(this.projectOutputs.get(id), chunk);
    this.projectOutputs.set(id, output);
    const failureDetails = this.projectFailureDetails.get(id);
    if (failureDetails) {
      const summary = startFailureSummary(output, failureDetails);
      this.projectFailureSummaries.set(id, summary);
      const project = this.projects.find((item) => item.id === id);
      if (project) {
        this.persistStartFailure(project, failureDetails, summary);
      }
    }
    if ((this.mode === 'output' && this.selectedProjectId === id)
      || (this.mode === 'list' && this.expandedPreviewProjectId === id)) {
      this.outputUpdateScheduler.schedule(id);
    }
  }

  projectHasLiveTimeline(id, project, status = this.getProjectStatus(id)) {
    if (!project?.services?.length) {
      return false;
    }
    if (this.projectTimelineFailures.has(id)) {
      return true;
    }
    return ['starting', 'running', 'not-ready', 'not-responding'].includes(status)
      && (this.managedProjectIds.has(id)
        || this.processes.has(id)
        || this.projectRuntime.has(id));
  }

  recordTimelineFailure(id, details = {}) {
    const metadata = this.projectAttemptMetadata.get(id) || {};
    this.projectTimelineFailures.set(id, {
      ...details,
      launchedAt: metadata.launchedAt,
      failedAt: Date.now()
    });
  }

  recordStartupOutcome(id, outcome, completedAt = Date.now()) {
    const metadata = this.projectAttemptMetadata.get(id);
    if (!metadata || metadata.historyRecorded) {
      return;
    }
    const entry = startupHistoryEntry(outcome, metadata.launchedAt, completedAt);
    if (!entry) {
      return;
    }
    metadata.historyRecorded = true;
    try {
      appendStartupHistory(this.projectsFile, id, entry);
    } catch {
      // Startup history is optional and must never affect project lifecycle actions.
    }
  }

  notifyServiceNotReady(project, status = 'not-ready', readinessDetails = {}) {
    if (this.readinessWarnings.has(project.id)) {
      return;
    }
    this.readinessWarnings.add(project.id);
    if (status === 'not-responding') {
      this.addProjectOutput(
        project.id,
        'Runlist: one or more configured web service ports are open, but their pages did not respond.\n'
      );
      void vscode.window.showWarningMessage(
        `${project.name} is still running, but one or more web services are not responding.`,
        'View output'
      ).then((choice) => {
        if (choice === 'View output') {
          this.showProjectOutput(project.id);
        }
      });
      return;
    }
    const stillChecking = [
      ...(readinessDetails.waiting || []),
      ...(readinessDetails.notResponding || [])
    ];
    const waiting = formatServiceList(stillChecking) || 'the configured services';
    const ready = formatServiceList(readinessDetails.ready);
    this.addProjectOutput(
      project.id,
      `Runlist: startup is taking longer than expected. Still checking ${waiting}.${ready ? ` Ready: ${ready}.` : ''}\n`
    );
    void vscode.window.showWarningMessage(
      `${project.name} is still running. Runlist is still checking ${waiting}.`,
      'View output'
    ).then((choice) => {
      if (choice === 'View output') {
        this.showProjectOutput(project.id);
      }
    });
  }

  showStartFailure(project, details = {}) {
    const normalizedDetails = typeof details === 'string' ? { detail: details } : details;
    this.recordStartupOutcome(project.id, 'failed');
    this.recordTimelineFailure(project.id, normalizedDetails);
    const summary = startFailureSummary(this.projectOutputs.get(project.id), normalizedDetails);
    this.projectFailureDetails.set(project.id, normalizedDetails);
    this.projectFailureSummaries.set(project.id, summary);
    this.persistStartFailure(project, normalizedDetails, summary);
    if (this.mode === 'output' && this.selectedProjectId === project.id) {
      this.outputUpdateScheduler.schedule(project.id);
    }
    void vscode.window.showErrorMessage(
      `Could not start ${project.name}: ${summary.message}`,
      'View output'
    ).then((choice) => {
      if (choice === 'View output') {
        this.showProjectOutput(project.id);
      }
    });
  }

  persistStartFailure(project, details, summary) {
    try {
      writeProjectDiagnostics(this.projectsFile, project.id, {
        output: this.projectOutputs.get(project.id),
        lifecycleState: this.getProjectStatus(project.id),
        exitCode: details.code,
        signal: details.signal,
        summary,
        failedAt: this.projectTimelineFailures.get(project.id)?.failedAt
      });
    } catch {
      // Recent output remains available in this VS Code window if diagnostics cannot be retained.
    }
  }

  async copyDiagnosisRequest() {
    const project = this.projects.find((item) => item.id === this.selectedProjectId);
    if (!project || !readProjectDiagnostics(this.projectsFile, project.id)) {
      return;
    }
    const request = [
      `Use the Runlist MCP tool runlist_get_project_diagnostics with projectId "${project.id}" to inspect ${project.name}'s latest failed start.`,
      'Explain the likely cause and the smallest safe fix.',
      'Do not change the saved Runlist setup unless you propose the change for my review and approval.'
    ].join(' ');
    await vscode.env.clipboard.writeText(request);
    this.view?.webview.postMessage({
      type: 'diagnosisRequestCopied',
      messageToken: this.webviewMessageToken
    });
  }

  sendProjectOutput(id) {
    const showingFullOutput = this.mode === 'output' && this.selectedProjectId === id;
    const showingPeek = this.mode === 'list' && this.expandedPreviewProjectId === id;
    if (!showingFullOutput && !showingPeek) {
      return;
    }
    const rawOutput = this.projectOutputs.get(id) || '';
    if (showingPeek) {
      this.view?.webview.postMessage({
        type: 'projectOutputPeek',
        messageToken: this.webviewMessageToken,
        id,
        entries: projectOutputPeek(rawOutput)
      });
      return;
    }
    this.view?.webview.postMessage({
      type: 'projectOutput',
      messageToken: this.webviewMessageToken,
      entries: formatProjectOutput(rawOutput),
      failureSummary: this.projectFailureSummaries.get(id),
      output: sanitizeProjectOutput(rawOutput)
    });
  }

  async copyProjectOutput() {
    const output = sanitizeProjectOutput(this.projectOutputs.get(this.selectedProjectId) || '');
    if (!output) {
      return;
    }
    await vscode.env.clipboard.writeText(output);
    this.view?.webview.postMessage({
      type: 'outputCopied',
      messageToken: this.webviewMessageToken
    });
  }

  async openOutputUrl(value) {
    const url = safeHttpUrl(value);
    if (!url) {
      return;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) {
      vscode.window.showErrorMessage(`Could not open ${url}.`);
    }
  }

  async externalServiceUrl(value) {
    const url = safeHttpUrl(value);
    if (!url) {
      return undefined;
    }
    try {
      const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
      return safeHttpUrl(externalUri.toString());
    } catch {
      return undefined;
    }
  }

  async openProject(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }
    const status = this.getProjectStatus(id);
    const previewService = projectPreviewService(
      project,
      status,
      this.projectServiceUrls.get(id),
      this.projectPortConflicts.has(id)
    );
    if (!previewService) {
      if (['running', 'starting', 'not-ready', 'not-responding', 'active'].includes(status)) {
        vscode.window.showInformationMessage(`${project.name} does not have a responding web service to open.`);
        return;
      }
      vscode.window.showInformationMessage(`Start ${project.name} before opening it.`);
      return;
    }
    const service = project.services.find((item) => item.port === previewService.port);
    const portStatus = await servicePortStatus([service]);
    const [reachable] = await reachableServiceUrls([service], portStatus.openPorts, {
      resolveUrl: (url) => this.externalServiceUrl(url)
    });
    if (!reachable) {
      vscode.window.showInformationMessage(`${service.name} is not responding as a web service.`);
      await this.refreshProjectStatuses();
      return;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(reachable.url));
    if (!opened) {
      vscode.window.showErrorMessage(`Could not open ${project.name} at ${reachable.url}.`);
    }
  }

  async copyServiceUrl(id, port) {
    const project = this.projects.find((item) => item.id === id);
    const service = project?.services?.find((item) => item.port === port);
    if (!project || !service) {
      return;
    }

    const portStatus = await servicePortStatus([service]);
    const [reachable] = await reachableServiceUrls([service], portStatus.openPorts, {
      resolveUrl: (url) => this.externalServiceUrl(url)
    });
    if (!reachable) {
      vscode.window.showInformationMessage(`${service.name} is not responding as a web service.`);
      await this.refreshProjectStatuses();
      return;
    }

    await vscode.env.clipboard.writeText(reachable.url);
    vscode.window.showInformationMessage(`Copied ${service.name} URL.`);
  }

  toggleProjectPreview(id) {
    const project = this.projects.find((item) => item.id === id);
    const status = this.getProjectStatus(id);
    const previewService = projectPreviewService(
      project,
      status,
      this.projectServiceUrls.get(id),
      this.projectPortConflicts.has(id)
    );
    const hasTimeline = this.projectHasLiveTimeline(id, project, status);
    const hasHistory = readStartupHistory(this.projectsFile, id).length > 0;
    if (!previewService && !hasTimeline && !hasHistory) {
      return;
    }

    if (this.expandedPreviewProjectId === id
      && (!previewService || this.expandedPreviewServicePort === previewService.port)) {
      this.expandedPreviewProjectId = undefined;
      this.expandedPreviewServicePort = undefined;
    } else {
      this.expandedPreviewProjectId = id;
      if (previewService) {
        this.expandedPreviewServicePort = previewService.port;
      } else {
        this.expandedPreviewServicePort = undefined;
      }
    }
    this.focusTarget = { type: 'action', action: 'toggle-preview', id };
    this.renderProjectList();
  }

  syncResourceSampling(id) {
    if (this.resourceSampleProjectId === id && this.resourceSampleTimer) {
      return;
    }
    this.stopResourceSampling();
    if (!id) {
      return;
    }

    this.resourceSampleProjectId = id;
    const child = this.processes.get(id);
    if (!child || !this.processOwnership.owns(id, child.pid)) {
      this.publishProjectMetrics(id, {
        available: false,
        message: 'Resource use is available in the VS Code window that started this project.'
      });
      return;
    }

    const generation = ++this.resourceSampleGeneration;
    let sampling = false;
    const sample = async () => {
      if (sampling || generation !== this.resourceSampleGeneration) {
        return;
      }
      const currentChild = this.processes.get(id);
      if (currentChild !== child || !this.processOwnership.owns(id, child.pid)) {
        this.stopResourceSampling();
        this.publishProjectMetrics(id, {
          available: false,
          message: 'Resource use stopped because process ownership is uncertain.'
        });
        return;
      }
      sampling = true;
      const metrics = await this.ownedProcessMetrics.sample(id, child.pid);
      sampling = false;
      if (generation !== this.resourceSampleGeneration || this.expandedPreviewProjectId !== id) {
        return;
      }
      this.publishProjectMetrics(id, metrics);
      if (!metrics.available && /ownership/.test(metrics.message || '')) {
        this.stopResourceSampling();
      }
    };
    void sample();
    this.resourceSampleTimer = setInterval(() => void sample(), RESOURCE_SAMPLE_INTERVAL_MS);
  }

  stopResourceSampling() {
    const projectId = this.resourceSampleProjectId;
    clearInterval(this.resourceSampleTimer);
    this.resourceSampleTimer = undefined;
    this.resourceSampleProjectId = undefined;
    this.resourceSampleGeneration += 1;
    if (projectId) {
      this.runtimePulseHistory.clear(projectId);
    }
  }

  publishProjectMetrics(id, metrics) {
    this.projectMetrics.set(id, metrics);
    const runtimePulse = this.runtimePulseHistory.append(id, metrics);
    void this.view?.webview.postMessage({
      type: 'projectMetrics',
      messageToken: this.webviewMessageToken,
      id,
      metrics,
      runtimePulse
    });
  }

  forgetProjectMetrics(id) {
    this.ownedProcessMetrics.untrack(id);
    this.projectMetrics.delete(id);
    this.runtimePulseHistory.clear(id);
    if (this.resourceSampleProjectId === id) {
      this.stopResourceSampling();
    }
  }

  async openProjectFolder(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    try {
      await openProjectInNewWindow(vscode, project.folder);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open ${project.name} in VS Code: ${error.message}`);
    }
  }

  async openProjectTerminal(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    if (!projectFolderIsAccessible(fs, project.folder)) {
      const selection = await vscode.window.showErrorMessage(
        `Could not open a terminal for ${project.name}: its saved folder is missing or inaccessible.`,
        'Edit project'
      );
      if (selection === 'Edit project') {
        this.showEditProject(id);
      } else {
        this.focusTarget = { type: 'project-menu', id };
        this.renderProjectList();
      }
      return;
    }

    try {
      openProjectTerminal(vscode, project.folder);
    } catch {
      await vscode.window.showErrorMessage(`Could not open a terminal for ${project.name}.`);
      this.focusTarget = { type: 'project-menu', id };
      this.renderProjectList();
    }
  }

  async copyProjectPath(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    try {
      await writeProjectPathToClipboard(vscode, project.folder);
      vscode.window.showInformationMessage(`Copied ${project.name} path.`);
    } catch {
      vscode.window.showErrorMessage(`Could not copy the path for ${project.name}.`);
    } finally {
      this.focusTarget = { type: 'project-menu', id };
      this.renderProjectList();
    }
  }

  toggleProjectPin(id) {
    try {
      const project = toggleProjectPinned(this.projectsFile, id);
      if (!project) {
        return;
      }
      this.focusTarget = { type: 'project-menu', id };
      this.renderProjectList();
    } catch (error) {
      vscode.window.showErrorMessage(`Could not update this project: ${error.message}`);
    }
  }

  async pickFolder(draft = {}) {
    this.draft = { ...this.draft, ...draft };
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use project folder'
    });

    if (selection?.[0]) {
      this.draft.folder = selection[0].fsPath;
      this.formErrors = {};
      this.focusTarget = { type: 'field', id: 'folder' };
      this.render();
    }
  }

  async useCurrentWorkspace(draft = {}) {
    this.draft = { ...this.draft, ...draft };
    const folder = await selectCurrentWorkspaceFolder(vscode);
    if (!folder) {
      return;
    }

    this.draft.folder = folder;
    this.formErrors = {};
    this.focusTarget = { type: 'field', id: 'folder' };
    this.render();
  }

  async saveProject(project) {
    const validation = validateProjectForm(project);
    this.draft = validation.values;
    if (validation.firstField) {
      this.formErrors = validation.errors;
      this.focusTarget = { type: 'field', id: validation.firstField };
      this.render();
      return;
    }

    let projectId = validation.values.id || this.selectedProjectId;
    const name = validation.values.name.trim();
    const folder = validation.values.folder.trim();
    const startCommand = validation.values.startCommand.trim();
    const stopCommand = validation.values.stopCommand.trim();
    const services = projectFormServices(validation.values);
    const existingProject = this.projects.find((item) => item.id === projectId);
    const servicesChanged = Boolean(existingProject)
      && projectServicesChanged(validation.values, existingProject);
    const servicesLocked = existingProject
      && ['running', 'starting', 'not-ready', 'not-responding', 'stopping', 'active']
        .includes(this.getProjectStatus(projectId));
    if (servicesLocked && servicesChanged) {
      this.formErrors = { services: 'Stop this project before changing its services.' };
      this.focusTarget = { type: 'field', id: 'services' };
      this.render();
      return;
    }

    let servicesReservation = false;
    if (servicesChanged) {
      const ownershipConflict = this.processOwnership.reserve(projectId);
      if (ownershipConflict) {
        this.formErrors = { services: 'Stop this project before changing its services.' };
        this.focusTarget = { type: 'field', id: 'services' };
        this.render();
        return;
      }
      servicesReservation = true;
    }

    try {
      const saved = upsertProject(this.projectsFile, {
        id: projectId,
        name,
        folder,
        startCommand,
        stopCommand,
        services
      }, { reviewRequired: false });
      projectId = saved.project.id;
      clearProjectDiagnostics(this.projectsFile, projectId);
    } catch (error) {
      const formError = projectSaveError(error);
      this.formErrors = { [formError.field]: formError.message };
      this.focusTarget = formError.field === 'form'
        ? { type: 'field', id: 'form-error-summary' }
        : { type: 'field', id: formError.field };
      this.render();
      return;
    } finally {
      if (servicesReservation) {
        this.processOwnership.release(projectId);
      }
    }

    this.mode = 'list';
    this.searchQuery = '';
    this.draft = {};
    this.formBaseline = {};
    this.formErrors = {};
    this.focusTarget = { type: 'project-menu', id: projectId };
    this.returnFocus = undefined;
    this.selectedProjectId = undefined;
    this.render();
  }

  async deleteProject(id) {
    const projects = this.projects;
    const projectIndex = projects.findIndex((item) => item.id === id);
    const project = projects[projectIndex];
    if (!project) {
      return;
    }

    const sharedOwnership = this.processOwnership.snapshot().get(id);
    const detail = this.processes.has(id) || sharedOwnership
      ? 'This removes the saved project from Runlist and stops its running process. Project files are not deleted.'
      : 'This removes the saved project from Runlist. Project files are not deleted.';
    const choice = await vscode.window.showWarningMessage(
      `Delete ${project.name} from Runlist?`,
      { modal: true, detail },
      'Delete project'
    );

    if (choice !== 'Delete project') {
      this.view?.webview.postMessage({
        type: 'restoreProjectMenuFocus',
        messageToken: this.webviewMessageToken,
        id
      });
      return;
    }

    const latestProject = this.projects.find((item) => item.id === id);
    if (!latestProject) {
      return;
    }
    const latestSharedOwnership = this.processOwnership.snapshot().get(id);
    const hadTrackedProcess = this.processes.has(id);
    try {
      if (hadTrackedProcess) {
        const stopped = await cleanupTrackedProcessForDeletion(
          this.processes,
          id,
          latestProject,
          (approvedProject) => this.stopProject(id, approvedProject)
        );
        if (!stopped) {
          return;
        }
        this.processOwnership.release(id);
      } else if (latestSharedOwnership) {
        const stopRequested = await this.stopProject(id, latestProject);
        if (!stopRequested || !await this.waitForProjectStopCompletion(id)) {
          vscode.window.showErrorMessage(
            `Could not delete ${project.name}: Runlist could not confirm that its launched process stopped.`
          );
          return;
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
      return;
    }
    const deletionConflict = this.processOwnership.reserve(id);
    if (deletionConflict) {
      vscode.window.showErrorMessage(
        `Could not delete ${project.name}: it started in another VS Code window while deletion was in progress.`
      );
      return;
    }

    try {
      removeProject(this.projectsFile, id);
      const remainingProjects = projects.filter((item) => item.id !== id);
      const adjacentProject = remainingProjects[projectIndex] || remainingProjects[projectIndex - 1];
      this.managedProjectIds.delete(id);
      this.statusRevision += 1;
      this.portReservations.releaseShared(id);
      this.releaseStartReservation(id);
      this.projectStatuses.delete(id);
      this.projectPortConflicts.delete(id);
      this.projectOpenPorts.delete(id);
      this.projectRespondingPorts.delete(id);
      this.projectServiceUrls.delete(id);
      this.projectWebPorts.delete(id);
      this.projectRuntime.delete(id);
      this.projectAttemptMetadata.delete(id);
      this.projectTimelineFailures.delete(id);
      if (this.expandedPreviewProjectId === id) {
        this.expandedPreviewProjectId = undefined;
        this.expandedPreviewServicePort = undefined;
      }
      this.startReadinessDeadlines.delete(id);
      this.readinessWarnings.delete(id);
      this.stoppingProjectIds.delete(id);
      this.remoteStopRequests.delete(id);
      this.projectOutputs.delete(id);
      this.projectFailureSummaries.delete(id);
      this.projectFailureDetails.delete(id);
      clearProjectDiagnostics(this.projectsFile, id);
      clearStartupHistory(this.projectsFile, id);
      if (this.selectedProjectId === id) {
        this.outputUpdateScheduler.cancel();
      }
      this.mode = 'list';
      this.draft = {};
      this.formBaseline = {};
      this.formErrors = {};
      this.focusTarget = adjacentProject
        ? { type: 'project-menu', id: adjacentProject.id }
        : { type: 'action', action: 'show-add' };
      this.selectedProjectId = undefined;
      this.render();
    } finally {
      this.processOwnership.release(id);
    }
  }

  async waitForProjectStopCompletion(id, timeoutMs = REMOTE_STOP_TIMEOUT_MS + 1000) {
    const deadline = Date.now() + timeoutMs;
    while (this.processOwnership.snapshot().has(id) || this.portReservations.snapshot().has(id)) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.remoteStopRequests.delete(id);
    this.stoppingProjectIds.delete(id);
    this.managedProjectIds.delete(id);
    this.projectStatuses.set(id, 'stopped');
    return true;
  }

  releaseStartReservation(id) {
    this.startAttempts.delete(id);
    this.portReservations.release(id);
  }

  async startProject(id, options = {}) {
    let projects = this.projects;
    let project = projects.find((item) => item.id === id);
    if (!project) {
      return false;
    }
    if (project.reviewRequired) {
      vscode.window.showWarningMessage(`Review and approve ${project.name}'s setup before running its commands.`);
      this.showEditProject(id);
      return false;
    }

    const currentStatus = this.getProjectStatus(id);
    if (currentStatus !== 'stopped' && !options.allowPortConflict) {
      if (['port-in-use', 'port-in-use-unknown'].includes(currentStatus)) {
        vscode.window.showWarningMessage('A configured app port is already in use. Stop the running app before starting this project.');
      }
      return false;
    }

    if (!options.ownershipReserved) {
      const ownershipConflict = this.processOwnership.reserve(id);
      if (ownershipConflict) {
        vscode.window.showWarningMessage(ownershipConflict.kind === 'uncertain'
          ? `Runlist cannot safely verify who owns ${project.name}'s previous process. Close it manually before starting again.`
          : `${project.name} is already running in another VS Code window.`);
        return false;
      }
    }

    projects = this.projects;
    project = projects.find((item) => item.id === id);
    if (!project) {
      this.processOwnership.release(id);
      return false;
    }
    if (project.reviewRequired) {
      this.processOwnership.release(id);
      vscode.window.showWarningMessage(`Review and approve ${project.name}'s setup before running its commands.`);
      this.showEditProject(id);
      return false;
    }

    const reservationConflict = this.portReservations.reserve(project);
    if (reservationConflict) {
      this.processOwnership.release(id);
      const owner = projects.find((candidate) => candidate.id === reservationConflict.projectId);
      const processRuntime = this.processOwnership.snapshot();
      const reservationConflicts = this.portReservations.conflicts(project);
      const ownership = processRuntime.get(reservationConflict.projectId);
      const allReservationsMatchOwner = reservationConflicts.length > 0
        && reservationConflicts.every((conflict) => conflict.projectId === reservationConflict.projectId);
      const conflict = owner
        && ownership?.ownerAvailable
        && ownership.processActive
        && ownership.state !== 'stopping'
        && allReservationsMatchOwner
        ? { kind: 'managed', owner, port: reservationConflict.port }
        : {
            kind: 'ambiguous',
            port: reservationConflict.port,
            sharedWith: owner ? [owner] : []
          };
      this.statusRevision += 1;
      this.projectStatuses.set(id, conflict.kind === 'managed'
        ? 'port-in-use'
        : 'port-in-use-unknown');
      this.projectPortConflicts.set(
        id,
        portConflictSummary(conflict, processRuntime, reservationConflicts)
      );
      vscode.window.showWarningMessage(
        conflict.kind === 'managed'
          ? `${owner.name} has reserved port :${reservationConflict.port}. Runlist is checking whether a safe switch is available.`
          : `Port :${reservationConflict.port} is reserved, but Runlist cannot safely verify the running owner. Nothing was stopped.`
      );
      this.renderProjectList();
      return false;
    }

    const attempt = Symbol(id);
    this.statusRevision += 1;
    this.startAttempts.set(id, attempt);
    this.projectPortConflicts.delete(id);
    this.projectOpenPorts.delete(id);
    this.projectRespondingPorts.delete(id);
    this.projectServiceUrls.delete(id);
    this.projectWebPorts.delete(id);
    this.projectTimelineFailures.delete(id);
    this.projectAttemptMetadata.delete(id);
    this.projectStatuses.set(id, 'starting');
    this.renderProjectList();

    const portStatus = project.services?.length
      ? await servicePortStatus(project.services)
      : { allOpen: false, anyOpen: false, openPorts: [] };
    if (this.startAttempts.get(id) !== attempt) {
      return false;
    }
    if (portStatus.anyOpen) {
      const conflict = occupiedPortConflict({
        project,
        projects,
        managedProjectIds: this.managedProjectIds,
        openPorts: portStatus.openPorts
      });
      this.statusRevision += 1;
      this.processOwnership.release(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, conflict?.kind === 'managed'
        ? 'port-in-use'
        : conflict?.kind === 'ambiguous'
          ? 'port-in-use-unknown'
          : 'active');
      const conflictSummary = portConflictSummary(conflict);
      if (conflictSummary) {
        this.projectPortConflicts.set(id, conflictSummary);
      }
      vscode.window.showWarningMessage(startBlockedMessage(project, conflict));
      this.renderProjectList();
      return false;
    }

    try {
      this.managedProjectIds.add(id);
      const hasServices = Boolean(project.services?.length);
      const readinessDeadline = hasServices
        ? Date.now() + START_READINESS_TIMEOUT_MS
        : undefined;
      this.projectStatuses.set(id, hasServices ? 'starting' : 'running');
      if (readinessDeadline) {
        this.startReadinessDeadlines.set(id, readinessDeadline);
      }
      clearProjectDiagnostics(this.projectsFile, id);
      this.projectOutputs.set(id, '');
      this.projectFailureSummaries.delete(id);
      this.projectFailureDetails.delete(id);
      const launchedAt = Date.now();
      this.projectAttemptMetadata.set(id, { launchedAt });
      const child = spawn(project.startCommand, {
        cwd: project.folder,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        ...projectProcessSpawnOptions()
      });

      this.processes.set(id, child);
      if (!hasServices) {
        this.projectAttemptMetadata.get(id).readyAt = launchedAt;
      }
      this.projectMetrics.delete(id);
      this.ownedProcessMetrics.track(id, child.pid);
      this.processOwnership.setProcess(id, child.pid, {
        state: hasServices ? 'starting' : 'running',
        readinessDeadline,
        launchedAt,
        ...(hasServices ? {} : { readyAt: launchedAt })
      });
      this.projectRuntime = this.processOwnership.snapshot();
      this.startAttempts.delete(id);
      this.portReservations.setState(id, hasServices ? 'starting' : 'running');
      this.statusRevision += 1;
      listenToProjectOutput(child, (chunk) => this.addProjectOutput(id, chunk));
      child.once('error', (error) => {
        this.recordStartupOutcome(id, 'failed');
        this.statusRevision += 1;
        this.processes.delete(id);
        this.forgetProjectMetrics(id);
        this.projectRuntime.delete(id);
        this.managedProjectIds.delete(id);
        this.processOwnership.release(id);
        this.portReservations.releaseShared(id);
        this.releaseStartReservation(id);
        this.projectStatuses.set(id, 'stopped');
        this.startReadinessDeadlines.delete(id);
        this.readinessWarnings.delete(id);
        this.showStartFailure(project, error.message);
        this.renderProjectList();
      });
      child.once('exit', (code, signal) => {
        if (this.processes.get(id) === child) {
          const stoppedIntentionally = this.stoppingProjectIds.has(id);
          const startFailed = startExitFailed({ code, hasServices, stoppedIntentionally });
          if (startFailed) {
            this.recordStartupOutcome(id, 'failed');
          }
          this.statusRevision += 1;
          this.processes.delete(id);
          this.forgetProjectMetrics(id);
          this.projectRuntime.delete(id);
          this.processOwnership.release(id);
          this.managedProjectIds.delete(id);
          this.portReservations.releaseShared(id);
          this.releaseStartReservation(id);
          this.projectStatuses.set(id, 'stopped');
          this.startReadinessDeadlines.delete(id);
          this.readinessWarnings.delete(id);
          if (startFailed) {
            this.showStartFailure(project, { code, signal });
          } else {
            this.projectAttemptMetadata.delete(id);
            this.projectTimelineFailures.delete(id);
          }
          this.renderProjectList();
          this.refreshProjectStatuses();
        }
      });
      this.renderProjectList();
      return true;
    } catch (error) {
      this.recordStartupOutcome(id, 'failed');
      this.statusRevision += 1;
      this.managedProjectIds.delete(id);
      this.processOwnership.release(id);
      this.portReservations.releaseShared(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, 'stopped');
      this.startReadinessDeadlines.delete(id);
      this.readinessWarnings.delete(id);
      this.showStartFailure(project, error.message);
      this.renderProjectList();
      return false;
    }
  }

  async handoffProject(id) {
    const requestedProject = this.projects.find((project) => project.id === id);
    if (!requestedProject || requestedProject.reviewRequired) {
      return false;
    }

    let conflictOwnerName = 'the conflicting project';
    let failureMessage;
    let succeeded = false;
    try {
      succeeded = await handoffProjectSafely(this.handoffProjectIds, id, {
        reserveRequested: () => {
          const reservationConflict = this.processOwnership.reserve(id);
          if (!reservationConflict) {
            return true;
          }
          failureMessage = reservationConflict.kind === 'uncertain'
            ? `Runlist cannot safely verify ${requestedProject.name}'s current ownership. Nothing was stopped.`
            : `${requestedProject.name} is already starting or running in another VS Code window.`;
          return false;
        },
        currentConflict: async () => {
          const projects = this.projects;
          const latestRequestedProject = projects.find((project) => project.id === id);
          if (!latestRequestedProject || latestRequestedProject.reviewRequired) {
            failureMessage = `${requestedProject.name}'s setup changed before Runlist could switch projects. Nothing was stopped.`;
            return undefined;
          }
          const reservationConflicts = this.portReservations.conflicts(latestRequestedProject);
          const ownerIds = new Set(reservationConflicts.map((conflict) => conflict.projectId));
          if (reservationConflicts.length === 0 || ownerIds.size !== 1) {
            failureMessage = reservationConflicts.length > 1
              ? `${requestedProject.name} now conflicts with more than one project. Runlist did not stop anything.`
              : `The port conflict for ${requestedProject.name} changed before Runlist could switch projects. Nothing was stopped.`;
            return undefined;
          }
          const ownerId = reservationConflicts[0].projectId;
          const owner = projects.find((project) => project.id === ownerId);
          const ownership = this.processOwnership.snapshot().get(ownerId);
          const portStatus = await servicePortStatus(latestRequestedProject.services || []);
          conflictOwnerName = owner?.name || conflictOwnerName;
          if (!owner
            || !ownership?.ownerAvailable
            || !ownership.processActive
            || ownership.state === 'stopping'
            || !occupiedPortsBelongToProject(
              portStatus.openPorts,
              reservationConflicts,
              ownerId
            )) {
            failureMessage = `Runlist can no longer verify that ${conflictOwnerName} owns the conflicting process. Nothing was stopped.`;
            return undefined;
          }
          return { owner, ownership };
        },
        stop: (conflict) => this.stopProject(conflict.owner.id, undefined, {
          expectedOwnershipToken: conflict.ownership.token
        }),
        waitForStop: async (conflict) => {
          const stopped = await this.waitForProjectStopCompletion(conflict.owner.id);
          if (!stopped) {
            failureMessage = `Runlist could not confirm that ${conflict.owner.name} stopped, so ${requestedProject.name} was not started.`;
          }
          return stopped;
        },
        start: () => this.startProject(id, {
          allowPortConflict: true,
          ownershipReserved: true
        }),
        releaseRequested: () => this.processOwnership.release(id)
      });
    } catch (error) {
      failureMessage = `Could not switch to ${requestedProject.name}: ${error.message}`;
    }

    if (!succeeded && failureMessage) {
      vscode.window.showErrorMessage(failureMessage);
    }
    this.focusTarget = succeeded
      ? { type: 'project-control', id }
      : { type: 'action', action: 'handoff', id };
    this.renderProjectList();
    void this.refreshProjectStatuses();
    return succeeded;
  }

  async stopProject(id, projectSnapshot, options = {}) {
    const project = projectSnapshot || this.projects.find((item) => item.id === id);
    if (!project) {
      return false;
    }
    if (project.reviewRequired) {
      vscode.window.showWarningMessage(`Review and approve ${project.name}'s setup before running its commands.`);
      this.showEditProject(id);
      return false;
    }

    if (this.startAttempts.has(id)) {
      this.statusRevision += 1;
      this.processOwnership.release(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, 'stopped');
      this.renderProjectList();
      return true;
    }

    if (this.getProjectStatus(id) === 'stopping') {
      return false;
    }

    const sharedOwnership = this.processOwnership.snapshot().get(id);
    if (options.expectedOwnershipToken
      && sharedOwnership?.token !== options.expectedOwnershipToken) {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: its Runlist ownership changed before the handoff. Nothing was stopped.`
      );
      return false;
    }
    const locallyOwnedWithoutHandle = sharedOwnership
      && this.processOwnership.owns(id, sharedOwnership.childPid);
    if (project.stopCommand
      && sharedOwnership
      && !this.processes.has(id)
      && !locallyOwnedWithoutHandle) {
      return this.stopOwnedProjectProcess(id, project, options);
    }

    if (project.stopCommand) {
      const customStopSucceeded = await this.runCustomStopCommand(project);
      if (!customStopSucceeded) {
        return false;
      }
      const remainingOwnership = this.processOwnership.snapshot().get(id);
      const stillOwned = this.processes.has(id) || Boolean(remainingOwnership?.processActive);
      if (stillOwned && !await this.waitForProjectStopCompletion(id, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS)) {
        vscode.window.showErrorMessage(
          `Could not stop ${project.name}: the custom stop command finished, but the launched process is still running.`
        );
        this.finishStopping(id, false);
        return false;
      }
      if (!stillOwned) {
        this.finishStopping(id, true);
      }
      return true;
    }

    return this.stopOwnedProjectProcess(id, project, options);
  }

  async restartProject(id) {
    const project = this.projects.find((candidate) => candidate.id === id);
    if (!project) {
      return false;
    }
    return restartProjectSafely(this.restartingProjectIds, id, {
      canRestart: () => {
        const sharedState = this.processOwnership.snapshot().get(id)?.state
          || this.portReservations.snapshot().get(id);
        return ['running', 'not-ready', 'not-responding', 'active'].includes(this.getProjectStatus(id))
          && (this.getProjectStatus(id) !== 'active' || Boolean(project.stopCommand))
          && !['starting', 'stopping'].includes(sharedState);
      },
      stop: () => this.stopProject(id),
      waitForStop: () => this.waitForProjectStopCompletion(id),
      start: () => this.startProject(id)
    });
  }

  beginStopping(id) {
    this.stoppingProjectIds.add(id);
    this.processOwnership.setState(id, 'stopping');
    this.portReservations.setState(id, 'stopping');
    this.statusRevision += 1;
    this.projectStatuses.set(id, 'stopping');
    this.renderProjectList();
  }

  finishStopping(id, succeeded) {
    this.stoppingProjectIds.delete(id);
    this.statusRevision += 1;
    if (succeeded) {
      this.managedProjectIds.delete(id);
      this.processOwnership.release(id);
      this.projectRuntime.delete(id);
      this.projectAttemptMetadata.delete(id);
      this.projectTimelineFailures.delete(id);
      this.releaseStartReservation(id);
    } else {
      const project = this.projects.find((candidate) => candidate.id === id);
      const hasServices = Boolean(project?.services?.length);
      const readinessTimedOut = hasServices
        && Date.now() >= (this.startReadinessDeadlines.get(id) || Infinity);
      const state = hasServices
        ? readinessTimedOut ? 'not-ready' : 'starting'
        : 'running';
      this.processOwnership.setState(id, state);
      this.portReservations.setState(id, state);
      this.projectStatuses.set(id, state);
    }
    if (succeeded) {
      this.startReadinessDeadlines.delete(id);
      this.readinessWarnings.delete(id);
      this.projectStatuses.set(id, 'stopped');
    }
    this.renderProjectList();
    setTimeout(() => this.refreshProjectStatuses(), 250);
  }

  async stopOwnedProjectProcess(id, project, options = {}) {
    if (options.expectedOwnershipToken
      && this.processOwnership.snapshot().get(id)?.token !== options.expectedOwnershipToken) {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: its Runlist ownership changed before the handoff. Nothing was stopped.`
      );
      return false;
    }
    if (this.startAttempts.has(id)) {
      this.processOwnership.release(id);
      this.projectRuntime.delete(id);
      this.projectAttemptMetadata.delete(id);
      this.projectTimelineFailures.delete(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, 'stopped');
      this.renderProjectList();
      return true;
    }
    if (this.processes.has(id)) {
      this.beginStopping(id);
      try {
        await terminateTrackedProcess(this.processes, id);
        this.finishStopping(id, true);
        return true;
      } catch (error) {
        vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
        this.finishStopping(id, false);
        return false;
      }
    }

    const request = this.processOwnership.requestStop(id, options.expectedOwnershipToken);
    if (request.kind === 'requested') {
      this.remoteStopRequests.set(id, { projectName: project.name, requestedAt: Date.now() });
      this.beginStopping(id);
      return true;
    }
    if (request.kind === 'local') {
      this.beginStopping(id);
      try {
        const stopped = await this.processOwnership.terminateOwnedProcess(id);
        if (!stopped) {
          throw new Error('Runlist could not verify the persisted process ownership details.');
        }
        this.finishStopping(id, true);
        return true;
      } catch (error) {
        vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
        this.finishStopping(id, false);
        return false;
      }
    }
    if (request.kind === 'uncertain') {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: its launching VS Code window is unavailable, so Runlist cannot safely verify the process owner. The process was left running.`
      );
      return false;
    }
    if (request.kind === 'changed') {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: its Runlist ownership changed before the handoff. Nothing was stopped.`
      );
      return false;
    }
    if (options.allowMissing) {
      this.finishStopping(id, true);
      return true;
    }

    vscode.window.showErrorMessage(
      `Could not stop ${project.name}: Runlist does not own a launched process for it. No process was stopped.`
    );
    return false;
  }

  runCustomStopCommand(project) {
    this.beginStopping(project.id);
    return new Promise((resolve) => {
      const stopProcess = spawn(project.stopCommand, {
        cwd: project.folder,
        env: process.env,
        ...customStopSpawnOptions()
      });
      let finalized = false;
      let stderr = '';
      stopProcess.stderr?.setEncoding('utf8');
      stopProcess.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      const finalize = (succeeded) => {
        if (finalized) {
          return;
        }
        finalized = true;
        clearTimeout(stopTimeout);
        if (!succeeded) {
          this.finishStopping(project.id, false);
        }
        resolve(succeeded);
      };
      const stopTimeout = setTimeout(() => {
        stopProcess.kill();
        vscode.window.showErrorMessage(`Could not stop ${project.name}: the custom stop command did not finish.`);
        finalize(false);
      }, CUSTOM_STOP_TIMEOUT_MS);

      stopProcess.once('error', (error) => {
        vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
        finalize(false);
      });
      stopProcess.once('exit', (code) => {
        if (code !== 0) {
          const detail = lastUsefulLine(stderr);
          vscode.window.showErrorMessage(
            `Could not stop ${project.name}: ${detail || `custom stop command exited with code ${code}.`}`
          );
        }
        finalize(code === 0);
      });
    });
  }

  stopAllProjects() {
    const projects = this.projects.map((project) => ({
      ...project,
      status: this.getProjectStatus(project.id)
    }));
    for (const id of stoppableProjectIds(projects)) {
      this.stopProject(id);
    }
  }

  render() {
    if (!this.view) {
      return;
    }

    const stylesUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css')
    );
    const scriptUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );
    const nonce = crypto.randomBytes(16).toString('base64');
    this.webviewMessageToken = nonce;
    const projects = this.projects;
    const outputProject = this.mode === 'output'
      ? projects.find((project) => project.id === this.selectedProjectId)
      : undefined;
    const diagnosisProject = this.mode === 'diagnosis'
      ? projects.find((project) => project.id === this.selectedProjectId)
      : undefined;
    const diagnosisRecord = diagnosisProject
      ? readProjectDiagnostics(this.projectsFile, diagnosisProject.id)
      : undefined;
    const rawProjectOutput = outputProject
      ? this.projectOutputs.get(outputProject.id) || ''
      : '';
    const outputDiagnostics = outputProject
      ? readProjectDiagnostics(this.projectsFile, outputProject.id)
      : undefined;
    const cleanProjectOutput = sanitizeProjectOutput(rawProjectOutput);
    const stateProjects = projects.map((project) => {
      const openPorts = this.projectOpenPorts.get(project.id) || [];
      const respondingPorts = this.projectRespondingPorts.get(project.id) || [];
      const serviceUrls = this.projectServiceUrls.get(project.id) || [];
      const webPorts = this.projectWebPorts.get(project.id) || [];
      const status = this.getProjectStatus(project.id);
      const previewService = projectPreviewService(
        project,
        status,
        serviceUrls,
        this.projectPortConflicts.has(project.id)
      );
      const canPreview = Boolean(previewService);
      const timelineVisible = this.projectHasLiveTimeline(project.id, project, status);
      const runtime = this.projectRuntime.get(project.id);
      const attempt = this.projectAttemptMetadata.get(project.id);
      const failure = this.projectTimelineFailures.get(project.id);
      const timelineAttention = ['not-ready', 'not-responding'].includes(status);
      const commandLaunched = Boolean(runtime?.launchedAt
        || attempt?.launchedAt
        || runtime?.processActive
        || this.processes.has(project.id));
      const timelineStages = serviceTimelineStages({
        services: project.services,
        commandLaunched,
        openPorts,
        respondingPorts,
        webPorts,
        failed: Boolean(failure),
        attention: timelineAttention
      });
      const readyAt = runtime?.readyAt || attempt?.readyAt;
      const timeline = timelineVisible ? {
        failed: Boolean(failure),
        attention: timelineAttention,
        launchedAt: runtime?.launchedAt || attempt?.launchedAt || failure?.launchedAt,
        readyAt,
        outputAvailable: this.projectOutputs.has(project.id),
        stages: timelineStages
      } : undefined;
      const detailsExpanded = this.expandedPreviewProjectId === project.id
        && (!canPreview || this.expandedPreviewServicePort === previewService.port);
      const previewExpanded = canPreview && detailsExpanded;
      const outputPeekVisible = detailsExpanded
        && ['starting', 'running', 'not-ready', 'not-responding'].includes(status)
        && (this.managedProjectIds.has(project.id)
          || this.processes.has(project.id)
          || this.projectRuntime.has(project.id));
      const locallyOwned = this.processes.has(project.id);
      const startupHistory = readStartupHistory(this.projectsFile, project.id);
      return {
        ...project,
        pinned: project.pinned === true,
        openPorts,
        portConflict: this.projectPortConflicts.get(project.id),
        respondingPorts,
        serviceReadiness: serviceReadinessDetails(
          project.services,
          openPorts,
          respondingPorts,
          webPorts
        ),
        serviceUrls,
        status,
        timeline,
        detailsExpanded,
        handoffInProgress: this.handoffProjectIds.has(project.id),
        outputPeek: outputPeekVisible
          ? projectOutputPeek(this.projectOutputs.get(project.id))
          : undefined,
        timelineExpanded: timelineVisible && detailsExpanded,
        previewExpanded,
        previewPort: previewService?.port,
        previewUrl: previewService?.url,
        startupHistory,
        resourceMetrics: previewExpanded
          ? this.projectMetrics.get(project.id) || (locallyOwned
            ? { available: true, measuring: true }
            : {
                available: false,
                message: 'Resource use is available in the VS Code window that started this project.'
              })
          : undefined,
        runtimePulse: previewExpanded
          ? this.runtimePulseHistory.get(project.id)
          : undefined,
        webPorts,
        httpUnresponsive: webPorts.some((port) => openPorts.includes(port)
          && !respondingPorts.includes(port)),
        searchText: projectSearchText(project)
      };
    });
    if (this.expandedPreviewProjectId
      && !stateProjects.some((project) => project.detailsExpanded)) {
      const previousId = this.expandedPreviewProjectId;
      this.expandedPreviewProjectId = undefined;
      this.expandedPreviewServicePort = undefined;
      this.focusTarget = { type: 'project-control', id: previousId };
    }
    const state = {
      agentConnections: this.agentConnections,
      messageToken: nonce,
      mode: this.mode,
      searchQuery: this.searchQuery,
      draft: this.draft,
      canUseCurrentWorkspace: this.mode === 'add'
        && canUseCurrentWorkspace(vscode.workspace.workspaceFolders),
      focusTarget: this.focusTarget || this.lastFocusTarget,
      formErrors: this.formErrors,
      reviewRequired: this.mode === 'edit'
        && Boolean(projects.find((project) => project.id === this.selectedProjectId)?.reviewRequired),
      servicesLocked: this.mode === 'edit'
        && ['running', 'starting', 'not-ready', 'not-responding', 'stopping', 'active']
          .includes(this.getProjectStatus(this.selectedProjectId)),
      projectOutput: outputProject ? {
        canAskAgent: Boolean(outputDiagnostics),
        entries: formatProjectOutput(rawProjectOutput),
        failureSummary: this.projectFailureSummaries.get(outputProject.id)
          || outputDiagnostics?.failureSummary,
        name: outputProject.name,
        output: cleanProjectOutput,
        projectId: outputProject.id
      } : undefined,
      diagnosis: diagnosisProject && diagnosisRecord ? {
        agentReady: Object.values(this.agentConnections)
          .some((connection) => connection.status === 'success'),
        name: diagnosisProject.name,
        outputAvailable: Boolean(diagnosisRecord.retainedOutput),
        outputTruncated: diagnosisRecord.outputTruncated === true,
        projectId: diagnosisProject.id
      } : undefined,
      projects: stateProjects,
      runningAppIds: runningAppProjectIds(stateProjects),
      stopAllCount: stoppableProjectIds(stateProjects).length
    };
    const expandedPreview = stateProjects.find((project) => project.previewExpanded);
    const frameSource = previewFrameSource(expandedPreview?.previewUrl);

    this.view.webview.html = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view.webview.cspSource}; script-src 'nonce-${nonce}'; frame-src ${frameSource};">
          <link rel="stylesheet" href="${stylesUri}">
          <title>Runlist</title>
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.runlistState = ${safeJson(state)};</script>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>`;
    this.focusTarget = undefined;
    this.syncResourceSampling(expandedPreview?.id);
  }

  dispose() {
    this.stopResourceSampling();
    for (const id of [...this.processes.keys()]) {
      void terminateTrackedProcess(this.processes, id).then(
        () => this.processOwnership.release(id),
        () => {}
      );
    }
    this.portReservations.dispose();
  }
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function startBlockedMessage(project, conflict) {
  if (conflict?.kind === 'managed') {
    return `${conflict.owner.name} is already using port :${conflict.port}. Stop it before starting ${project.name}.`;
  }
  if (conflict?.kind === 'ambiguous') {
    const names = conflict.sharedWith.map((candidate) => candidate.name).join(', ');
    return `Port :${conflict.port} is already in use and is also configured for ${names}. Runlist cannot safely identify its owner.`;
  }
  return `Port :${conflict?.port || 'unknown'} is already in use. ${project.name} appears to be running already.`;
}

function portConflictSummary(
  conflict,
  processRuntime = new Map(),
  reservationConflicts = [],
  openPorts
) {
  if (conflict?.kind === 'managed') {
    const ownership = processRuntime.get(conflict.owner.id);
    const reservationOwnerIds = new Set(reservationConflicts.map((entry) => entry.projectId));
    const handoffAvailable = ownership?.ownerAvailable
      && ownership.processActive
      && ownership.state !== 'stopping'
      && reservationConflicts.length > 0
      && reservationOwnerIds.size === 1
      && reservationOwnerIds.has(conflict.owner.id)
      && occupiedPortsBelongToProject(openPorts, reservationConflicts, conflict.owner.id);
    return {
      kind: conflict.kind,
      ownerId: conflict.owner.id,
      ownerName: conflict.owner.name,
      port: conflict.port,
      handoffAvailable
    };
  }
  if (conflict?.kind === 'ambiguous') {
    return {
      kind: conflict.kind,
      port: conflict.port,
      projectNames: conflict.sharedWith.map((project) => project.name)
    };
  }
  return undefined;
}

function formatServiceList(services) {
  const labels = (services || []).map((service) => `${service.name} :${service.port}`);
  return labels.join(', ');
}

function portConflictMapsDiffer(left, right) {
  if (left.size !== right.size) {
    return true;
  }
  return [...left].some(([id, conflict]) => {
    const previous = right.get(id);
    return !previous
      || previous.kind !== conflict.kind
      || previous.port !== conflict.port
      || previous.ownerId !== conflict.ownerId
      || previous.ownerName !== conflict.ownerName
      || previous.handoffAvailable !== conflict.handoffAvailable
      || String(previous.projectNames) !== String(conflict.projectNames);
  });
}

function validFocusTarget(target) {
  if (!target || !['field', 'project-menu', 'project-control', 'action'].includes(target.type)) {
    return undefined;
  }
  const clean = { type: target.type };
  for (const key of ['id', 'action', 'agent']) {
    if (typeof target[key] === 'string' && target[key].length <= 200) {
      clean[key] = target[key];
    }
  }
  return clean;
}

function installedCodexCliPath() {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  return codexBundledCliPath(extension?.extensionPath);
}

function installedClaudeCliPaths() {
  const extension = vscode.extensions.getExtension('Anthropic.claude-code');
  return claudeBundledCliPaths(extension?.extensionPath);
}

function initialAgentConnection(agent) {
  try {
    const skill = agentSkillStatus({ agent, environment: process.env, platform: process.platform });
    if (skill.status === 'installed') {
      return {
        status: 'success',
        message: `Runlist skill installed. Use ${skill.invocation}, or select Refresh setup after an extension update.`
      };
    }
    if (skill.status === 'conflict') {
      return {
        status: 'error',
        message: `A different Runlist skill already exists at ${skill.targetDirectory}. Rename or remove it, then try again.`
      };
    }
  } catch (error) {
    return { status: 'error', message: registrationErrorMessage('Agent setup', error) };
  }
  return { status: 'idle', message: '' };
}

function registrationErrorMessage(clientLabel, error) {
  if (error.code === 'ENOENT') {
    return `${clientLabel} could not be found. Make sure it is installed, then try again.`;
  }

  const lines = String(error.message || 'Registration failed.')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = lines.at(-1) || 'Registration failed.';
  return detail.length > 240 ? `${detail.slice(0, 237)}…` : detail;
}

function lastUsefulLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function installMcpBridge(context) {
  const storageRoot = context.globalStorageUri.fsPath;
  const mcpRoot = path.join(storageRoot, 'mcp');
  const serverPath = path.join(mcpRoot, 'server.js');
  fs.mkdirSync(mcpRoot, { recursive: true });
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'mcp', 'server.js').fsPath,
    serverPath
  );
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'project-store.js').fsPath,
    path.join(storageRoot, 'project-store.js')
  );
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'external-url.js').fsPath,
    path.join(storageRoot, 'external-url.js')
  );
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'project-process.js').fsPath,
    path.join(storageRoot, 'project-process.js')
  );
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'project-output.js').fsPath,
    path.join(storageRoot, 'project-output.js')
  );
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'project-diagnostics.js').fsPath,
    path.join(storageRoot, 'project-diagnostics.js')
  );
  fs.copyFileSync(
    vscode.Uri.joinPath(context.extensionUri, 'package.json').fsPath,
    path.join(storageRoot, 'package.json')
  );
  return serverPath;
}

function activate(context) {
  const projectsFile = path.join(context.globalStorageUri.fsPath, 'projects.json');
  initializeProjectStore(projectsFile, context.globalState.get(STORAGE_KEY, []));

  const serverPath = installMcpBridge(context);
  const provider = new RunlistViewProvider(context, projectsFile, serverPath);
  context.subscriptions.push({ dispose: () => provider.dispose() });
  const handleProjectStoreChange = () => provider.renderProjectList();
  fs.watchFile(projectsFile, { interval: 500 }, handleProjectStoreChange);

  const mcpDefinition = new vscode.McpStdioServerDefinition(
    'Runlist',
    process.execPath,
    [serverPath],
    {
      ELECTRON_RUN_AS_NODE: '1',
      RUNLIST_PROJECTS_FILE: projectsFile
    },
    context.extension.packageJSON.version
  );
  mcpDefinition.cwd = context.globalStorageUri;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('runlist.projects', provider),
    vscode.commands.registerCommand('runlist.addProject', () => provider.showAddProject()),
    vscode.commands.registerCommand('runlist.showAgentSetup', () => provider.showAgentSetup()),
    vscode.lm.registerMcpServerDefinitionProvider('runlist.projects', {
      provideMcpServerDefinitions: () => [mcpDefinition],
      resolveMcpServerDefinition: (server) => server
    }),
    provider.startStatusMonitoring(),
    { dispose: () => fs.unwatchFile(projectsFile, handleProjectStoreChange) }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
