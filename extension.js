const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { safeHttpUrl } = require('./src/services/external-url');
const {
  claudeBundledCliPaths,
  codexBundledCliPath,
  registerWithClaude,
  registerWithCodex
} = require('./src/integrations/agent-registration');
const {
  agentSkillStatus,
  installAgentSkill
} = require('./src/integrations/skill-installation');
const {
  hasUnownedPortReservation,
  managedRuntimeProjectIds,
  projectServicesLocked,
  projectStatus,
  reachableServiceUrls,
  runningAppProjectIds,
  serviceHttpStatus,
  serviceReadinessDetails,
  serviceReadinessTimedOut,
  servicePortStatus,
  serviceTimelineStages,
  stoppableProjectIds
} = require('./src/lifecycle/project-status');
const {
  copyProjectPath: writeProjectPathToClipboard,
  openProjectInNewWindow,
  openProjectTerminal,
  projectFolderIsAccessible
} = require('./src/webview/project-navigation');
const { previewFrameSources, projectPreviewService } = require('./src/webview/preview-security');
const { createPhoneHandoff } = require('./src/webview/phone-handoff');
const { OwnedProcessMetrics } = require('./src/lifecycle/process-metrics');
const {
  findListeningProcesses,
  terminateListenerProcess
} = require('./src/ports/port-process');
const {
  managedPortBlockers,
  portClosureConfirmation,
  recoverProjectPorts,
  relatedPortProjectIds
} = require('./src/ports/port-recovery');
const { customStopPostcondition } = require('./src/lifecycle/custom-stop-recovery');
const {
  availableProjectDetailTabs,
  preferredProjectDetailTab
} = require('./src/webview/project-detail-tabs');
const { HttpResponseHistory, RuntimePulseHistory } = require('./src/lifecycle/runtime-pulse');
const {
  appendStartupHistory,
  averageReadyDuration,
  clearStartupHistory,
  readStartupHistory,
  replaceTimedOutStartupHistory,
  startupHistoryEntry
} = require('./src/lifecycle/startup-history');
const {
  canUseCurrentWorkspace,
  selectCurrentWorkspaceFolder
} = require('./src/projects/project-workspace');
const {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  ProcessOwnershipStore,
  projectStopStrategy,
  projectProcessSpawnOptions,
  readProcessIdentity,
  recordStartedProcess,
  rollbackStartedProcess,
  shutdownTrackedProcesses,
  shouldRequestRemoteCustomStop,
  startExitFailed,
  terminateProcessTree,
  terminateTrackedProcess
} = require('./src/lifecycle/project-process');
const {
  effectiveProjectPortOverrides,
  mergePortOverride,
  normalizePortOverrides,
  parseTemporaryPort,
  portVariableValidationMessage,
  projectLaunchEnvironment,
  projectWithPortOverrides
} = require('./src/ports/service-port-overrides');
const {
  detectLifecycleCapability,
  projectLifecycleCapability
} = require('./src/lifecycle/lifecycle-capability');
const {
  occupiedPortsBelongToProject,
  occupiedPortConflict,
  PortReservationStore
} = require('./src/ports/port-gate');
const {
  projectFormChanged,
  projectFormSetup,
  projectFormServices,
  projectServicesChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
} = require('./src/projects/project-form');
const {
  appendProjectOutput,
  createOutputUpdateScheduler,
  formatProjectOutput,
  listenToProjectOutput,
  projectOutputPeek,
  sanitizeProjectOutput,
  startFailureSummary
} = require('./src/projects/project-output');
const {
  clearProjectDiagnostics,
  readProjectDiagnostics,
  writeProjectDiagnostics
} = require('./src/projects/project-diagnostics');
const { projectSearchText } = require('./src/projects/project-search');
const { projectTagVocabulary } = require('./src/projects/project-tags');
const {
  launchProfileOptions,
  resolveLaunchProfile,
  selectedLaunchProfileId
} = require('./src/projects/launch-profile');
const { ProjectLifecycleCoordinator } = require('./src/lifecycle/project-lifecycle');
const { createRunlistWebviewRouter } = require('./src/webview/webview-message-router');
const {
  approveProjectRepairProposal,
  clearProjectRepairProposal,
  projectConfigurationRevision,
  projectRepairComparison,
  readProjectRepairProposal
} = require('./src/projects/project-repair');
const { runProjectTransferWorkflow } = require('./src/projects/project-transfer');
const {
  RunGroupCoordinator,
  runGroupManagementWorkflow
} = require('./src/groups/run-groups');
const {
  initializeProjectStore,
  pinnedProjectsFirst,
  ProjectStoreError,
  readProjects,
  readRunGroups,
  removeProject,
  removeRunGroup,
  selectProjectLaunchProfile,
  toggleProjectPinned,
  upsertProject,
  upsertRunGroup
} = require('./src/projects/project-store');

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
    this.lifecycleCapability = detectLifecycleCapability({
      remoteName: vscode.env.remoteName,
      platform: process.platform
    });
    this.view = undefined;
    this.mode = 'list';
    this.searchQuery = '';
    this.tagFilter = '';
    this.draft = {};
    this.formBaseline = {};
    this.formProjectSnapshot = undefined;
    this.formErrors = {};
    this.focusTarget = undefined;
    this.lastFocusTarget = undefined;
    this.returnFocus = undefined;
    this.selectedProjectId = undefined;
    this.approvedRepairProjectId = undefined;
    this.expandedPreviewProjectId = undefined;
    this.expandedPreviewServicePort = undefined;
    this.processes = new Map();
    this.ownedProcessMetrics = new OwnedProcessMetrics();
    this.projectMetrics = new Map();
    this.runtimePulseHistory = new RuntimePulseHistory();
    this.httpResponseHistory = new HttpResponseHistory();
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
    this.runGroupCoordinator = new RunGroupCoordinator(
      path.join(path.dirname(projectsFile), 'run-group-invocations')
    );
    this.runGroupStates = new Map();
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
    this.forceClosingProjectIds = new Set();
    this.stoppingProjectIds = new Set();
    this.remoteStopRequests = new Map();
    this.statusRefreshInFlight = false;
    this.statusRefreshPending = false;
    this.statusRefreshPromise = undefined;
    this.statusRevision = 0;
    this.lifecycle = new ProjectLifecycleCoordinator(this, {
      isServiceReady: async (service) => {
        const portStatus = await servicePortStatus([service]);
        if (!portStatus.allOpen) {
          return false;
        }
        const httpStatus = await serviceHttpStatus([service], portStatus.openPorts, {
          resolveUrl: (url) => this.externalServiceUrl(url)
        });
        return httpStatus.allResponding;
      },
      remoteStopTimeoutMs: REMOTE_STOP_TIMEOUT_MS,
      servicePortStatus,
      showErrorMessage: (...args) => vscode.window.showErrorMessage(...args),
      showWarningMessage: (...args) => vscode.window.showWarningMessage(...args),
      startReadinessTimeoutMs: START_READINESS_TIMEOUT_MS,
      statusPollIntervalMs: STATUS_POLL_INTERVAL_MS
    });
    this.routeWebviewMessage = createRunlistWebviewRouter(this, {
      projectFormValues,
      validFocusTarget
    });
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
    this.formProjectSnapshot = undefined;
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

  async showProjectTransfer() {
    let lockSnapshot;
    return runProjectTransferWorkflow({
      projectsFile: this.projectsFile,
      window: vscode.window,
      workspace: vscode.workspace,
      isProjectActive: (project) => {
        lockSnapshot ||= {
          localProcessIds: [...this.processes.keys()],
          portRuntime: this.portReservations.snapshot(),
          processRuntime: this.processOwnership.snapshot()
        };
        return this.getProjectStatus(project.id) === 'active'
          || this.projectSetupLocked(project.id, lockSnapshot);
      },
      reserveUpdatedProjects: (ids) => this.reserveProjectUpdates(ids),
      onImported: () => this.renderProjectList()
    });
  }

  async showRunGroupManager(selectedGroupId) {
    return runGroupManagementWorkflow({
      selectedGroupId,
      groups: this.groups,
      projects: this.projects,
      window: vscode.window,
      saveGroup: async (group, expectedGroup) => {
        upsertRunGroup(this.projectsFile, group, { expectedGroup });
        this.renderProjectList();
      },
      removeGroup: async (id, expectedGroup) => {
        removeRunGroup(this.projectsFile, id, { expectedGroup });
        this.runGroupStates.delete(id);
        this.renderProjectList();
      },
      startGroup: (id) => this.startSavedRunGroup(id),
      stopGroup: (id) => this.stopSavedRunGroup(id)
    });
  }

  get projects() {
    return pinnedProjectsFirst(readProjects(this.projectsFile));
  }

  get groups() {
    return readRunGroups(this.projectsFile);
  }

  async startSavedRunGroup(id) {
    const group = this.groups.find((candidate) => candidate.id === id);
    const blockedProject = group?.projectIds
      .map((projectId) => this.projects.find((project) => project.id === projectId))
      .find((project) => project && !this.lifecycleCapabilityFor(project).supported);
    if (blockedProject) {
      this.showLifecycleBlocked(blockedProject);
      return false;
    }
    return this.lifecycle.startGroup(id);
  }

  async stopSavedRunGroup(id) {
    const group = this.groups.find((candidate) => candidate.id === id);
    const blockedProject = group?.projectIds
      .map((projectId) => this.projects.find((project) => project.id === projectId))
      .find((project) => project && !this.lifecycleCapabilityFor(project).supported);
    if (blockedProject) {
      this.showLifecycleBlocked(blockedProject);
      return false;
    }
    return this.lifecycle.stopGroup(id);
  }

  async setRunGroupStartMode(id, startMode) {
    try {
      const group = this.groups.find((candidate) => candidate.id === id);
      if (!group || this.runGroupStates.get(id)?.busy) {
        return false;
      }
      upsertRunGroup(this.projectsFile, { ...group, startMode }, { expectedGroup: group });
      this.renderProjectList();
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Could not change run group mode: ${error.message}`);
      this.renderProjectList();
      return false;
    }
  }

  lifecycleCapabilityFor(project) {
    return projectLifecycleCapability(this.lifecycleCapability, project, process.platform);
  }

  showLifecycleBlocked(project) {
    const capability = this.lifecycleCapabilityFor(project);
    if (!capability.supported) {
      vscode.window.showWarningMessage(`${project.name}: ${capability.reason}`);
    }
    return capability.supported;
  }

  updateRunGroupProgress(group, progress) {
    const project = progress.project
      || readProjects(this.projectsFile).find((candidate) => candidate.id === progress.projectId);
    const states = {
      starting: {
        busy: true,
        message: `Starting ${project?.name || 'project'} (${progress.index + 1}/${progress.total})…`
      },
      'starting-parallel': {
        busy: true,
        message: `Starting ${progress.eligibleTotal} project${progress.eligibleTotal === 1 ? '' : 's'} in parallel…`
      },
      'parallel-progress': {
        busy: true,
        message: `${progress.readyCount} of ${progress.eligibleTotal} ready in parallel…`
      },
      skipped: {
        busy: true,
        message: `${project?.name || 'Project'} is already running (${progress.index + 1}/${progress.total}).`
      },
      ready: {
        busy: true,
        message: `${project?.name || 'Project'} is ready (${progress.index + 1}/${progress.total}).`
      },
      'rolling-back': {
        busy: true,
        message: `Start failed. Stopping ${project?.name || 'a project'}…`
      },
      stopping: {
        busy: true,
        message: `Stopping ${project?.name || 'project'}…`
      },
      started: { busy: false, message: 'All group projects are ready.' },
      stopped: { busy: false, message: 'Owned group processes stopped.' },
      failed: {
        busy: false,
        message: project
          ? `Blocked by ${project.name}.`
          : 'The group could not complete safely.'
      }
    };
    this.runGroupStates.set(group.id, states[progress.status] || {
      busy: false,
      message: 'The group could not complete safely.'
    });
    this.renderProjectList();
  }

  async waitForProjectReady(id) {
    return this.lifecycle.waitUntilReady(id);
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
      this.statusRefreshPending = true;
      return this.statusRefreshPromise;
    }

    this.statusRefreshInFlight = true;
    let finishRefresh;
    const refreshPromise = new Promise((resolve) => { finishRefresh = resolve; });
    this.statusRefreshPromise = refreshPromise;
    const revision = this.statusRevision;
    try {
      await Promise.all([
        this.portReservations.reconcileProcessIdentities(),
        this.processOwnership.reconcileProcessIdentities()
      ]);
      for (const id of this.processOwnership.consumeStopRequests()) {
        const project = this.projects.find((candidate) => candidate.id === id);
        void Promise.resolve(this.stopProject(id, project || { id, name: 'this project' }))
          .finally(() => this.processOwnership.completeStopRequest(id))
          .catch(() => {});
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
        const ownership = processRuntime.get(id);
        if (!ownership) {
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
        } else if (ownership.state !== 'stopping') {
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
          vscode.window.showErrorMessage(
            `Could not confirm that ${request.projectName} stopped: its launching VS Code window left the process ownership unchanged.`
          );
        } else if (now - request.requestedAt >= REMOTE_STOP_TIMEOUT_MS) {
          this.processOwnership.cancelStopRequest(id);
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
          vscode.window.showErrorMessage(
            `Could not confirm that ${request.projectName} stopped: its launching VS Code window did not respond. Runlist left the process ownership unchanged.`
          );
        }
      }
      const managedProjectIds = managedRuntimeProjectIds({
        localProcessIds: this.processes.keys(),
        processRuntime,
        startAttemptIds: this.startAttempts.keys()
      });
      for (const id of [...this.managedProjectIds]) {
        if (!managedProjectIds.has(id)) {
          this.managedProjectIds.delete(id);
          this.portReservations.release(id);
          this.startReadinessDeadlines.delete(id);
        }
      }
      const effectiveProjects = projects.map((project) => projectStopStrategy(
        project,
        processRuntime.get(project.id)
      ));
      const checks = await Promise.all(effectiveProjects.map(async (project) => {
        if (project.reviewRequired) {
          return [project.id, 'stopped', undefined, [], [], [], [], []];
        }
        const capability = this.lifecycleCapabilityFor(project);
        if (!capability.supported) {
          return [project.id, 'unsupported', undefined, [], [], [], [], []];
        }
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
        const sharedState = ownership?.state;
        const readinessDeadline = ownership?.readinessDeadline
          || this.startReadinessDeadlines.get(project.id);
        const allReady = portStatus.allOpen && httpStatus.allResponding;
        const readinessTimedOut = hasServices
          && managedProjectIds.has(project.id)
          && (sharedState === 'running'
            || serviceReadinessTimedOut(readinessDeadline, allReady, now));
        const conflict = occupiedPortConflict({
          project,
          projects: effectiveProjects,
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
          ownerAvailable: ownership?.ownerAvailable,
          httpUnresponsive: httpStatus.unresponsivePorts.length > 0,
          partialPortConflict: !portStatus.allOpen && conflict?.kind === 'occupied',
          processActive: this.processes.has(project.id) || ownership?.processActive,
          readinessTimedOut,
          stopping: this.stoppingProjectIds.has(project.id) || sharedState === 'stopping',
        });
        return [
          project.id,
          status,
          ['port-in-use', 'port-in-use-unknown'].includes(status)
            ? portConflictSummary(
              conflict,
              processRuntime,
              this.portReservations.conflicts(project),
              portStatus.openPorts
            )
            : undefined,
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

      const httpResponseTarget = this.httpResponseHistory.currentTarget();
      if (httpResponseTarget) {
        const activeCheck = checks.find(([id]) => id === httpResponseTarget.projectId);
        const httpResponsePulse = this.httpResponseHistory.record(
          activeCheck?.[1],
          activeCheck?.[6]
        );
        this.publishProjectHttpPulse(httpResponseTarget.projectId, httpResponsePulse);
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
        .map(([id, , , , , , serviceUrls]) => [
          id,
          serviceUrls.map(({ port, url }) => ({ port, url }))
        ]));
      const nextRuntime = this.processOwnership.snapshot();
      const runtimeChanged = nextRuntime.size !== this.projectRuntime.size
        || [...nextRuntime].some(([id, runtime]) => {
          const previous = this.projectRuntime.get(id);
          return runtime.launchedAt !== previous?.launchedAt
            || runtime.readyAt !== previous?.readyAt
            || JSON.stringify(runtime.portOverrides) !== JSON.stringify(previous?.portOverrides);
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
      if (this.statusRefreshPending) {
        this.statusRefreshPending = false;
        await this.refreshProjectStatuses();
      }
      finishRefresh();
      if (this.statusRefreshPromise === refreshPromise) {
        this.statusRefreshPromise = undefined;
      }
    }
  }

  handleProjectStoreChange() {
    this.statusRevision += 1;
    this.renderProjectList();
    void this.refreshProjectStatuses();
  }

  async handleMessage(message) {
    return this.routeWebviewMessage(message);
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
    this.draft = projectFormValues(project);
    this.formBaseline = projectFormValues(project);
    this.formProjectSnapshot = JSON.parse(JSON.stringify(project));
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
    this.approvedRepairProjectId = undefined;
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
    this.formProjectSnapshot = undefined;
    this.formErrors = {};
    this.selectedProjectId = undefined;
    this.approvedRepairProjectId = undefined;
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
    return ['starting', 'running', 'not-ready', 'not-responding', 'ownership-lost'].includes(status)
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

  recordStartupOutcome(id, outcome, completedAt = Date.now(), failureSummary) {
    const metadata = this.projectAttemptMetadata.get(id);
    if (!metadata) {
      return;
    }
    const entry = startupHistoryEntry(outcome, metadata.launchedAt, completedAt, failureSummary);
    if (!entry) {
      return;
    }
    if (metadata.historyRecorded) {
      if (metadata.historyOutcome !== 'timed-out' || outcome !== 'failed') {
        return;
      }
      try {
        replaceTimedOutStartupHistory(this.projectsFile, id, metadata.launchedAt, entry);
        metadata.historyOutcome = 'failed';
      } catch {
        // Startup history is optional and must never affect project lifecycle actions.
      }
      return;
    }
    metadata.historyRecorded = true;
    metadata.historyOutcome = outcome;
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
    const summary = startFailureSummary(this.projectOutputs.get(project.id), normalizedDetails);
    this.recordStartupOutcome(project.id, 'failed', Date.now(), summary.message);
    this.recordTimelineFailure(project.id, normalizedDetails);
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
      const savedProject = this.projects.find((candidate) => candidate.id === project.id);
      const previousDiagnostic = readProjectDiagnostics(this.projectsFile, project.id);
      writeProjectDiagnostics(this.projectsFile, project.id, {
        output: this.projectOutputs.get(project.id),
        lifecycleState: this.getProjectStatus(project.id),
        exitCode: details.code,
        signal: details.signal,
        summary,
        projectRevision: details.projectRevision
          || projectConfigurationRevision(savedProject || project),
        launchProfileId: project.activeLaunchProfileId || previousDiagnostic?.launchProfileId,
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
      'If the saved setup should change, use runlist_propose_project_repair with the returned revision and failedAt value so I can review it in Runlist.',
      'Do not run commands or change the saved setup yourself.'
    ].join(' ');
    await vscode.env.clipboard.writeText(request);
    this.view?.webview.postMessage({
      type: 'diagnosisRequestCopied',
      messageToken: this.webviewMessageToken
    });
  }

  refreshProjectRepair() {
    if (this.mode === 'diagnosis') {
      this.render();
    }
  }

  async approveProjectRepair() {
    const project = this.projects.find((item) => item.id === this.selectedProjectId);
    if (!project || !readProjectRepairProposal(this.projectsFile, project.id)) {
      return false;
    }
    if (['active', 'not-ready', 'not-responding', 'ownership-lost', 'running', 'starting', 'stopping']
      .includes(this.getProjectStatus(project.id))) {
      vscode.window.showWarningMessage(`Stop ${project.name} before approving changes to its setup.`);
      return false;
    }
    const ownershipConflict = this.processOwnership.reserve(project.id);
    if (ownershipConflict) {
      vscode.window.showWarningMessage(`Stop ${project.name} before approving changes to its setup.`);
      return false;
    }
    try {
      approveProjectRepairProposal(this.projectsFile, project.id);
      this.approvedRepairProjectId = project.id;
      this.render();
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Could not approve the repair for ${project.name}: ${error.message}`);
      this.render();
      return false;
    } finally {
      this.processOwnership.release(project.id);
    }
  }

  async rejectProjectRepair() {
    const project = this.projects.find((item) => item.id === this.selectedProjectId);
    if (!project || !readProjectRepairProposal(this.projectsFile, project.id)) {
      return false;
    }
    const approved = await vscode.window.showWarningMessage(
      `Reject the repair proposal for ${project.name}?`,
      {
        modal: true,
        detail: 'The current saved setup remains unchanged.'
      },
      'Reject proposal'
    );
    if (approved !== 'Reject proposal') {
      return false;
    }
    clearProjectRepairProposal(this.projectsFile, project.id);
    this.render();
    return true;
  }

  async retryProjectRepair() {
    const projectId = this.approvedRepairProjectId;
    if (!projectId || projectId !== this.selectedProjectId) {
      return false;
    }
    this.approvedRepairProjectId = undefined;
    this.mode = 'list';
    this.selectedProjectId = undefined;
    this.focusTarget = { type: 'project-control', id: projectId };
    this.render();
    return this.startProject(projectId);
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
    const savedProject = this.projects.find((item) => item.id === id);
    const project = projectStopStrategy(
      savedProject,
      this.processOwnership.snapshot().get(id)
    );
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
      if (['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active'].includes(status)) {
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
    const savedProject = this.projects.find((item) => item.id === id);
    const project = projectStopStrategy(
      savedProject,
      this.processOwnership.snapshot().get(id)
    );
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

  async openServiceUrl(id, port) {
    const savedProject = this.projects.find((item) => item.id === id);
    const project = projectStopStrategy(
      savedProject,
      this.processOwnership.snapshot().get(id)
    );
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
    const opened = await vscode.env.openExternal(vscode.Uri.parse(reachable.url));
    if (!opened) {
      vscode.window.showErrorMessage(`Could not open ${service.name} at ${reachable.url}.`);
    }
  }

  async copyPhoneUrl(id, requestedUrl) {
    const savedProject = this.projects.find((item) => item.id === id);
    const project = projectStopStrategy(
      savedProject,
      this.processOwnership.snapshot().get(id)
    );
    const status = this.getProjectStatus(id);
    const previewService = projectPreviewService(
      project,
      status,
      this.projectServiceUrls.get(id),
      this.projectPortConflicts.has(id)
    );
    const service = project?.services?.find((item) => item.port === previewService?.port);
    if (!service) {
      return;
    }

    const portStatus = await servicePortStatus([service]);
    const [reachable] = await reachableServiceUrls([service], portStatus.openPorts, {
      resolveUrl: (url) => this.externalServiceUrl(url)
    });
    const phoneHandoff = createPhoneHandoff(reachable?.url);
    if (!phoneHandoff || phoneHandoff.url !== requestedUrl) {
      vscode.window.showInformationMessage('The local network address changed. Reopen Open on phone and try again.');
      await this.refreshProjectStatuses();
      return;
    }

    await vscode.env.clipboard.writeText(phoneHandoff.url);
    vscode.window.showInformationMessage('Copied phone URL.');
  }

  toggleProjectPreview(id, focusAction = 'toggle-preview') {
    const savedProject = this.projects.find((item) => item.id === id);
    const project = projectStopStrategy(
      savedProject,
      this.processOwnership.snapshot().get(id)
    );
    const status = this.getProjectStatus(id);
    const previewService = projectPreviewService(
      project,
      status,
      this.projectServiceUrls.get(id),
      this.projectPortConflicts.has(id)
    );
    const hasTimeline = this.projectHasLiveTimeline(id, project, status);
    const hasHistory = readStartupHistory(this.projectsFile, id).length > 0;
    if (!previewService && !hasTimeline && !hasHistory && !project?.services?.length) {
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
    this.syncHttpResponsePulseTarget(
      this.expandedPreviewProjectId,
      this.expandedPreviewServicePort,
      this.expandedPreviewProjectId ? previewService?.url : undefined
    );
    this.focusTarget = { type: 'action', action: focusAction, id };
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
      runtimePulse,
      httpResponsePulse: this.httpResponseHistory.get(id)
    });
  }

  syncHttpResponsePulseTarget(id, port, url) {
    this.httpResponseHistory.setTarget(id, port, url);
  }

  publishProjectHttpPulse(id, httpResponsePulse) {
    void this.view?.webview.postMessage({
      type: 'projectHttpPulse',
      messageToken: this.webviewMessageToken,
      id,
      httpResponsePulse
    });
  }

  forgetProjectMetrics(id) {
    this.ownedProcessMetrics.untrack(id);
    this.projectMetrics.delete(id);
    this.runtimePulseHistory.clear(id);
    this.httpResponseHistory.clear(id);
    if (this.httpResponseHistory.currentTarget()?.projectId === id) {
      this.httpResponseHistory.setTarget(undefined, undefined, undefined);
    }
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

  selectLaunchProfile(id, profileId) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return false;
    }
    if (this.projectSetupLocked(id)) {
      vscode.window.showWarningMessage(`Stop ${project.name} before changing its launch profile.`);
      this.focusTarget = { type: 'action', action: 'toggle-profile-menu', id };
      this.renderProjectList();
      return false;
    }
    const ownershipConflict = this.processOwnership.reserve(id);
    if (ownershipConflict) {
      vscode.window.showWarningMessage(`Runlist cannot safely change ${project.name}'s launch profile while it may be running elsewhere.`);
      this.focusTarget = { type: 'action', action: 'toggle-profile-menu', id };
      this.renderProjectList();
      return false;
    }
    try {
      selectProjectLaunchProfile(this.projectsFile, id, profileId);
      this.statusRevision += 1;
      this.focusTarget = { type: 'action', action: 'toggle-profile-menu', id };
      this.renderProjectList();
      void this.refreshProjectStatuses();
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Could not change this launch profile: ${error.message}`);
      this.focusTarget = { type: 'action', action: 'toggle-profile-menu', id };
      this.renderProjectList();
      return false;
    } finally {
      this.processOwnership.release(id);
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
      this.focusTarget = {
        type: 'field',
        id: validation.firstField === 'form' ? 'form-error-summary' : validation.firstField
      };
      this.render();
      return;
    }

    let projectId = validation.values.id || this.selectedProjectId;
    const name = validation.values.name.trim();
    const folder = validation.values.folder.trim();
    const setup = projectFormSetup(validation.values);
    const existingProject = this.projects.find((item) => item.id === projectId);
    const servicesChanged = Boolean(existingProject)
      && projectServicesChanged(validation.values, existingProject);
    const servicesLocked = existingProject && this.projectSetupLocked(projectId);
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
        ...setup
      }, {
        expectedProject: existingProject ? this.formProjectSnapshot : undefined,
        reviewRequired: false
      });
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
    this.formProjectSnapshot = undefined;
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

    const processRuntime = this.processOwnership.snapshot();
    if (hasUnownedPortReservation(id, {
      localProcessIds: this.processes.keys(),
      portRuntime: this.portReservations.snapshot(),
      processRuntime
    })) {
      vscode.window.showErrorMessage(
        `Could not delete ${project.name}: Runlist cannot verify the process behind its saved port reservation. Nothing was stopped or deleted.`
      );
      return;
    }
    const sharedOwnership = processRuntime.get(id);
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
    const latestProcessRuntime = this.processOwnership.snapshot();
    if (hasUnownedPortReservation(id, {
      localProcessIds: this.processes.keys(),
      portRuntime: this.portReservations.snapshot(),
      processRuntime: latestProcessRuntime
    })) {
      vscode.window.showErrorMessage(
        `Could not delete ${project.name}: its process ownership changed while deletion was in progress. Nothing was stopped or deleted.`
      );
      return;
    }
    const latestSharedOwnership = latestProcessRuntime.get(id);
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
        this.syncHttpResponsePulseTarget(undefined, undefined, undefined);
      }
      this.httpResponseHistory.clear(id);
      this.startReadinessDeadlines.delete(id);
      this.readinessWarnings.delete(id);
      this.stoppingProjectIds.delete(id);
      this.remoteStopRequests.delete(id);
      this.projectOutputs.delete(id);
      this.projectFailureSummaries.delete(id);
      this.projectFailureDetails.delete(id);
      clearProjectDiagnostics(this.projectsFile, id);
      try {
        clearProjectRepairProposal(this.projectsFile, id);
      } catch {
        // A pending proposal is disposable and must not block project deletion.
      }
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
    return this.lifecycle.waitUntilStopped(id, timeoutMs);
  }

  releaseStartReservation(id) {
    this.startAttempts.delete(id);
    this.portReservations.release(id);
  }

  reserveProjectUpdates(ids) {
    const reservedIds = [];
    const release = () => {
      for (const id of reservedIds) {
        this.processOwnership.release(id);
      }
    };

    for (const id of ids) {
      if (hasUnownedPortReservation(id, {
        localProcessIds: this.processes.keys(),
        portRuntime: this.portReservations.snapshot(),
        processRuntime: this.processOwnership.snapshot()
      })) {
        release();
        return false;
      }
      if (this.processOwnership.reserve(id)) {
        release();
        return false;
      }
      reservedIds.push(id);
    }
    return release;
  }

  projectSetupLocked(id, runtime = {}) {
    return projectServicesLocked(this.getProjectStatus(id), hasUnownedPortReservation(id, {
      localProcessIds: runtime.localProcessIds || this.processes.keys(),
      portRuntime: runtime.portRuntime || this.portReservations.snapshot(),
      processRuntime: runtime.processRuntime || this.processOwnership.snapshot()
    }));
  }

  async startProject(id, options = {}) {
    return this.lifecycle.start(id, options);
  }

  async startProjectProcess(id, options = {}) {
    let projects = this.projects;
    let project = projects.find((item) => item.id === id);
    if (!project) {
      return false;
    }
    if (!this.showLifecycleBlocked(project)) {
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

    const savedProjectRevision = projectConfigurationRevision(project);
    project = resolveLaunchProfile(project);
    let portOverrides;
    let launchProject;
    try {
      portOverrides = normalizePortOverrides(project, options.portOverrides);
      launchProject = projectWithPortOverrides(project, portOverrides);
    } catch (error) {
      this.processOwnership.release(id);
      vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
      return false;
    }
    const processRuntime = this.processOwnership.snapshot();
    const effectiveProjects = projects.map((candidate) => projectStopStrategy(
      candidate,
      processRuntime.get(candidate.id)
    ));
    const reservationConflict = this.portReservations.reserve(launchProject);
    if (reservationConflict) {
      this.processOwnership.release(id);
      const owner = projects.find((candidate) => candidate.id === reservationConflict.projectId);
      const reservationConflicts = this.portReservations.conflicts(launchProject);
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

    const portStatus = launchProject.services?.length
      ? await servicePortStatus(launchProject.services)
      : { allOpen: false, anyOpen: false, openPorts: [] };
    if (this.startAttempts.get(id) !== attempt) {
      return false;
    }
    if (portStatus.anyOpen) {
      const conflict = occupiedPortConflict({
        project: launchProject,
        projects: effectiveProjects,
        managedProjectIds: this.managedProjectIds,
        openPorts: portStatus.openPorts
      });
      this.statusRevision += 1;
      this.processOwnership.release(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, conflict?.kind === 'managed'
        ? 'port-in-use'
        : ['ambiguous', 'occupied'].includes(conflict?.kind)
          ? 'port-in-use-unknown'
          : 'active');
      const conflictSummary = portConflictSummary(conflict);
      if (conflictSummary) {
        this.projectPortConflicts.set(id, conflictSummary);
      }
      vscode.window.showWarningMessage(startBlockedMessage(launchProject, conflict));
      this.renderProjectList();
      return false;
    }

    try {
      this.managedProjectIds.add(id);
      const hasServices = Boolean(launchProject.services?.length);
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
      const child = spawn(launchProject.startCommand, {
        cwd: launchProject.folder,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: projectLaunchEnvironment(process.env, portOverrides),
        ...projectProcessSpawnOptions()
      });

      this.processes.set(id, child);
      listenToProjectOutput(child, (chunk) => this.addProjectOutput(id, chunk));
      child.once('error', (error) => {
        if (this.processes.get(id) !== child) {
          return;
        }
        this.statusRevision += 1;
        this.processes.delete(id);
        this.forgetProjectMetrics(id);
        this.projectRuntime.delete(id);
        this.managedProjectIds.delete(id);
        this.processOwnership.release(id);
        this.releaseStartReservation(id);
        this.projectStatuses.set(id, 'stopped');
        this.startReadinessDeadlines.delete(id);
        this.readinessWarnings.delete(id);
        this.showStartFailure(project, {
          detail: error.message,
          projectRevision: savedProjectRevision
        });
        this.renderProjectList();
      });
      child.once('exit', (code, signal) => {
        if (this.processes.get(id) === child) {
          const stoppedIntentionally = this.stoppingProjectIds.has(id);
          const startFailed = startExitFailed({ code, hasServices, stoppedIntentionally });
          this.statusRevision += 1;
          this.processes.delete(id);
          this.forgetProjectMetrics(id);
          this.projectRuntime.delete(id);
          this.processOwnership.release(id);
          this.managedProjectIds.delete(id);
          this.releaseStartReservation(id);
          this.projectStatuses.set(id, 'stopped');
          this.startReadinessDeadlines.delete(id);
          this.readinessWarnings.delete(id);
          if (startFailed) {
            this.showStartFailure(project, {
              code,
              signal,
              projectRevision: savedProjectRevision
            });
          } else {
            this.projectAttemptMetadata.delete(id);
            this.projectTimelineFailures.delete(id);
          }
          this.renderProjectList();
          this.refreshProjectStatuses();
        }
      });
      if (!hasServices) {
        this.projectAttemptMetadata.get(id).readyAt = launchedAt;
      }
      this.projectMetrics.delete(id);
      this.ownedProcessMetrics.track(id, child.pid);
      void recordStartedProcess(this.processOwnership, this.portReservations, launchProject, child, {
        state: hasServices ? 'starting' : 'running',
        readinessDeadline,
        launchedAt,
        portOverrides,
        ...(hasServices ? {} : { readyAt: launchedAt })
      });
      this.projectRuntime = this.processOwnership.snapshot();
      this.startAttempts.delete(id);
      this.portReservations.setState(id, hasServices ? 'starting' : 'running');
      this.statusRevision += 1;
      this.renderProjectList();
      return true;
    } catch (error) {
      this.statusRevision += 1;
      this.startAttempts.delete(id);
      const rollback = await rollbackStartedProcess(
        this.processes,
        id,
        this.processOwnership,
        this.portReservations
      );
      if (rollback.stopped) {
        this.forgetProjectMetrics(id);
        this.projectRuntime.delete(id);
        this.managedProjectIds.delete(id);
        this.projectStatuses.set(id, 'stopped');
      } else {
        const state = launchProject.services?.length ? 'not-ready' : 'running';
        this.processOwnership.setState(id, state);
        this.portReservations.setState(id, state);
        this.projectRuntime = this.processOwnership.snapshot();
        this.projectStatuses.set(id, state);
      }
      this.startReadinessDeadlines.delete(id);
      this.readinessWarnings.delete(id);
      this.showStartFailure(project, {
        detail: rollback.stopped
          ? error.message
          : `${error.message} Runlist also could not confirm cleanup: ${rollback.error.message}`,
        projectRevision: savedProjectRevision
      });
      this.renderProjectList();
      return false;
    }
  }

  async handoffProject(id) {
    const project = this.projects.find((candidate) => candidate.id === id);
    if (!project || !this.showLifecycleBlocked(project)) {
      return false;
    }
    return this.lifecycle.handoff(id);
  }

  async resolveServicePort(id, savedPort) {
    const storedProject = this.projects.find((candidate) => candidate.id === id);
    const savedProject = storedProject ? resolveLaunchProfile(storedProject) : undefined;
    const savedService = savedProject?.services?.find((service) => service.port === savedPort);
    if (!savedProject || !savedService || savedProject.reviewRequired) {
      return false;
    }
    if (!this.showLifecycleBlocked(savedProject)) {
      return false;
    }
    const displayedStatus = this.getProjectStatus(id);
    const displayedConflict = this.projectPortConflicts.get(id);
    if (['port-in-use', 'port-in-use-unknown'].includes(displayedStatus)
      && displayedConflict?.port !== savedPort) {
      return false;
    }

    const processRuntime = this.processOwnership.snapshot();
    const ownership = processRuntime.get(id);
    const project = projectStopStrategy(savedProject, ownership);
    const service = project.services?.find((candidate) => candidate.name === savedService.name);
    if (!service) {
      return false;
    }

    const portStatus = await servicePortStatus([service]);
    const managed = this.processes.has(id) || Boolean(ownership?.processActive);
    const reservationConflicts = this.portReservations.conflicts({
      ...project,
      services: [service]
    });
    const managedBlockers = managedPortBlockers(
      reservationConflicts.map((conflict) => conflict.projectId),
      processRuntime,
      this.projects
    );
    const conflict = this.projectPortConflicts.get(id);
    const choices = [];

    if (!portStatus.anyOpen && !managed) {
      choices.push({
        label: 'Try starting again',
        description: `Port :${service.port} is free now.`,
        action: 'start'
      });
    }
    if (portStatus.anyOpen
      && conflict?.handoffAvailable
      && conflict.port === service.port
      && conflict.ownerName) {
      choices.push({
        label: `Stop ${conflict.ownerName} and start`,
        description: 'Runlist will verify ownership again before stopping anything.',
        action: 'handoff'
      });
    } else if (portStatus.anyOpen && !managed && managedBlockers.length === 0) {
      choices.push({
        label: 'Close this port and start',
        description: `Review the exact process using :${service.port} before closing it.`,
        action: 'close'
      });
    }
    choices.push({
      label: managed ? 'Restart with a temporary port' : 'Use a temporary port',
      description: 'Enter the port variable and use a free port for this launch only.',
      action: 'temporary'
    });

    const choice = await vscode.window.showQuickPick(choices, {
      title: `Resolve ${savedProject.name} - ${savedService.name} :${service.port}`,
      placeHolder: 'Choose how Runlist should handle this service port'
    });
    if (!choice) {
      return false;
    }
    if (choice.action === 'start') {
      return this.startProject(id, { allowPortConflict: true });
    }
    if (choice.action === 'handoff') {
      return this.handoffProject(id);
    }
    if (choice.action === 'close') {
      return this.forceCloseProjectPorts(id, 'start', { servicePort: savedPort });
    }
    return this.startWithTemporaryServicePort(savedProject, savedService, ownership, managed);
  }

  async startWithTemporaryServicePort(project, service, ownership, restart) {
    let existingOverrides;
    try {
      existingOverrides = normalizePortOverrides(project, ownership?.portOverrides);
    } catch {
      vscode.window.showErrorMessage(
        `Could not use a temporary port for ${project.name}: its current launch settings are no longer valid.`
      );
      return false;
    }
    const existing = existingOverrides.find((override) => override.serviceName === service.name);
    const variable = await vscode.window.showInputBox({
      title: `${restart ? 'Restart' : 'Start'} ${project.name} with a temporary port`,
      prompt: `Port environment variable used by ${service.name}. This applies to this launch only.`,
      value: existing?.variable || service.portVariable || '',
      placeHolder: 'For example, API_PORT',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const validationMessage = portVariableValidationMessage(value);
        if (validationMessage) {
          return validationMessage;
        }
        const variableKey = value.trim().toLocaleLowerCase('en-US');
        if (existingOverrides.some((override) => (
          override.serviceName !== service.name
          && override.variable.toLocaleLowerCase('en-US') === variableKey
        ))) {
          return 'Use a different environment variable for each temporary port.';
        }
        return undefined;
      }
    });
    if (variable === undefined) {
      return false;
    }
    const portVariable = variable.trim();

    const suggestedPort = await this.suggestTemporaryServicePort(
      project,
      service,
      existingOverrides,
      portVariable
    );
    const portText = await vscode.window.showInputBox({
      title: `${restart ? 'Restart' : 'Start'} ${project.name} with a temporary port`,
      prompt: `Temporary port for ${service.name}. The saved port remains :${service.port}.`,
      value: String(existing?.port || suggestedPort || ''),
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const port = parseTemporaryPort(value);
          if (!port) {
            return 'Enter a whole-number port from 1 to 65535.';
          }
          mergePortOverride(project, existingOverrides, {
            serviceName: service.name,
            savedPort: service.port,
            port,
            variable: portVariable
          });
          return undefined;
        } catch (error) {
          return error.message;
        }
      }
    });
    if (portText === undefined) {
      return false;
    }

    let portOverrides;
    let temporaryProject;
    try {
      const port = parseTemporaryPort(portText);
      if (!port) {
        throw new Error('Enter a whole-number port from 1 to 65535.');
      }
      portOverrides = mergePortOverride(project, existingOverrides, {
        serviceName: service.name,
        savedPort: service.port,
        port,
        variable: portVariable
      });
      temporaryProject = projectWithPortOverrides(project, portOverrides);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not use a temporary port: ${error.message}`);
      return false;
    }

    const temporaryService = temporaryProject.services.find((candidate) => candidate.name === service.name);
    const [portStatus, reservationConflicts] = await Promise.all([
      servicePortStatus([temporaryService]),
      Promise.resolve(this.portReservations.conflicts(temporaryProject))
    ]);
    if (portStatus.anyOpen || reservationConflicts.length) {
      vscode.window.showWarningMessage(
        `Port :${temporaryService.port} is no longer available. Nothing was stopped; choose another temporary port.`
      );
      return false;
    }

    const started = restart
      ? await this.lifecycle.restart(project.id, { portOverrides })
      : await this.startProject(project.id, { allowPortConflict: true, portOverrides });
    if (!started) {
      return false;
    }
    const launchToken = this.processOwnership.snapshot().get(project.id)?.token;
    if (!launchToken) {
      return false;
    }
    const launchIsCurrent = () => (
      this.processOwnership.snapshot().get(project.id)?.token === launchToken
    );
    const acceptedOverride = await this.lifecycle.waitUntilServiceReady(
      temporaryService,
      undefined,
      launchIsCurrent
    );
    if (!launchIsCurrent()) {
      return false;
    }
    if (!acceptedOverride) {
      const stopped = await this.stopOwnedProjectProcess(project.id, temporaryProject, {
        allowMissing: true,
        expectedOwnershipToken: launchToken
      });
      vscode.window.showErrorMessage(
        `${project.name} did not open ${service.name} on :${temporaryService.port}. ${portVariable} may not be supported by its start command. ${stopped ? 'Runlist stopped the process tree it launched.' : 'Runlist could not confirm that its launched process stopped.'}`
      );
      return false;
    }
    vscode.window.showInformationMessage(
      `${project.name} is using ${service.name} on :${temporaryService.port} for this launch. Saved port :${service.port} was not changed.`
    );
    return true;
  }

  async suggestTemporaryServicePort(project, service, existingOverrides, variable) {
    const configuredPorts = new Set(project.services.map((candidate) => candidate.port));
    for (let offset = 1; offset <= 100; offset += 1) {
      const port = service.port + offset;
      if (port > 65535 || configuredPorts.has(port)) {
        continue;
      }
      try {
        const portOverrides = mergePortOverride(project, existingOverrides, {
          serviceName: service.name,
          savedPort: service.port,
          port,
          variable
        });
        const candidate = projectWithPortOverrides(project, portOverrides);
        const candidateService = candidate.services.find((item) => item.name === service.name);
        const [status, conflicts] = await Promise.all([
          servicePortStatus([candidateService]),
          Promise.resolve(this.portReservations.conflicts(candidate))
        ]);
        if (!status.anyOpen && conflicts.length === 0) {
          return port;
        }
      } catch {
        // Continue to the next candidate when this effective service set is invalid.
      }
    }
    return undefined;
  }

  async forceCloseProjectPorts(id, intent, options = {}) {
    const projects = this.projects;
    const storedProject = projects.find((candidate) => candidate.id === id);
    const savedProject = storedProject ? resolveLaunchProfile(storedProject) : undefined;
    if (!savedProject || savedProject.reviewRequired || !['start', 'stop'].includes(intent)) {
      return false;
    }
    if (!this.showLifecycleBlocked(savedProject)) {
      return false;
    }
    if (this.forceClosingProjectIds.has(id)) {
      return false;
    }

    const processRuntime = this.processOwnership.snapshot();
    const effectiveProjects = projects.map((candidate) => projectStopStrategy(
      candidate,
      processRuntime.get(candidate.id)
    ));
    const project = effectiveProjects.find((candidate) => candidate.id === id);
    const selectedSavedService = Number.isInteger(options.servicePort)
      ? savedProject.services?.find((service) => service.port === options.servicePort)
      : undefined;
    const selectedService = selectedSavedService
      ? project.services?.find((service) => service.name === selectedSavedService.name)
      : undefined;
    if (Number.isInteger(options.servicePort) && !selectedService) {
      return false;
    }
    const recoveryProject = selectedService
      ? { ...project, services: [selectedService] }
      : project;
    const relatedProjectIds = relatedPortProjectIds(
      recoveryProject,
      this.portReservations.conflicts(recoveryProject),
      effectiveProjects
    );
    if (intent === 'stop') {
      relatedProjectIds.add(id);
    }
    if (intent === 'start') {
      const blockers = managedPortBlockers(relatedProjectIds, processRuntime, effectiveProjects);
      if (blockers.length) {
        const names = blockers.map((blocker) => blocker.name).join(', ');
        vscode.window.showWarningMessage(
          `Stop or wait for ${names} in Runlist before closing the remaining ports and starting ${project.name}.`
        );
        return false;
      }
    }
    const additionalProcesses = [...relatedProjectIds].map((projectId) => {
      const ownership = processRuntime.get(projectId);
      const includeOwnedRoot = intent === 'stop' || ownership?.ownerAvailable === false;
      if (!includeOwnedRoot
        || !ownership.processActive
        || !Number.isInteger(ownership.childPid)
        || typeof ownership.childIdentity !== 'string') {
        return undefined;
      }
      const owner = this.projects.find((candidate) => candidate.id === projectId);
      return {
        pid: ownership.childPid,
        identity: ownership.childIdentity,
        name: owner ? `${owner.name} Runlist process` : 'Saved Runlist process',
        ports: [],
        terminateTree: true
      };
    }).filter(Boolean);

    this.forceClosingProjectIds.add(id);
    this.focusTarget = { type: 'project-control', id };
    this.renderProjectList();
    try {
      const result = await recoverProjectPorts(recoveryProject, intent, {
        additionalProcesses,
        getOpenPorts: async (services) => (await servicePortStatus(services)).openPorts,
        findListeningProcesses,
        confirmPortClosure: async ({ openPorts, processes }) => {
          const confirmation = portClosureConfirmation(recoveryProject, intent, openPorts, processes);
          const choice = await vscode.window.showWarningMessage(
            confirmation.message,
            { modal: true, detail: confirmation.detail },
            confirmation.confirmLabel
          );
          return choice === confirmation.confirmLabel;
        },
        protectedPids: new Set([
          process.pid,
          process.ppid,
          process.platform === 'win32' ? 4 : 1
        ]),
        terminateListenerProcess: (processInfo, terminationOptions) => terminateListenerProcess(
          processInfo,
          terminationOptions
        ),
        waitForPortsClosed: (services) => this.lifecycle.waitUntilServicesStopped(
          { ...recoveryProject, services },
          CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS
        )
      });

      if (result.status === 'canceled') {
        return false;
      }
      if (result.status === 'unresolved') {
        vscode.window.showErrorMessage(
          `Could not close ${project.name}'s ports: Runlist could not identify the exact process listening on ${formatPortList(result.ports)}.`
        );
        return false;
      }
      if (result.status === 'protected') {
        vscode.window.showErrorMessage(
          `Could not close ${project.name}'s ports because ${result.processes.join(', ')} is protected.`
        );
        return false;
      }
      if (result.status === 'changed') {
        vscode.window.showWarningMessage(
          `${project.name}'s port owner changed while the confirmation was open. Nothing was stopped; try again.`
        );
        return false;
      }
      if (result.status === 'still-open') {
        vscode.window.showErrorMessage(
          `Could not close ${project.name}'s ports: ${formatPortList(result.ports)} is still in use.`
        );
        return false;
      }

      if (intent === 'stop' && this.processes.has(id)) {
        await terminateTrackedProcess(this.processes, id, { allowMissing: true });
      }
      await this.refreshProjectStatuses();
      if (intent === 'start') {
        return this.startProject(id, { allowPortConflict: true });
      }
      this.finishStopping(id, true);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Could not close ${project.name}'s ports: ${error.message}`);
      return false;
    } finally {
      this.forceClosingProjectIds.delete(id);
      this.focusTarget = { type: 'project-control', id };
      this.renderProjectList();
      void this.refreshProjectStatuses();
    }
  }

  async stopProject(id, projectSnapshot, options = {}) {
    return this.lifecycle.stop(id, projectSnapshot, options);
  }

  async stopProjectProcess(id, projectSnapshot, options = {}) {
    const project = projectSnapshot || this.projects.find((item) => item.id === id);
    if (!project) {
      return false;
    }
    if (!this.showLifecycleBlocked(project)) {
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

    if (this.stoppingProjectIds.has(id)) {
      return false;
    }

    const sharedOwnership = this.processOwnership.snapshot().get(id);
    const stopProject = projectStopStrategy(project, sharedOwnership);
    if (options.expectedOwnershipToken
      && sharedOwnership?.token !== options.expectedOwnershipToken) {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: its Runlist ownership changed before the handoff. Nothing was stopped.`
      );
      return false;
    }
    const locallyOwnedWithoutHandle = sharedOwnership
      && this.processOwnership.owns(id, sharedOwnership.childPid);
    if (shouldRequestRemoteCustomStop(
      stopProject,
      sharedOwnership,
      this.processes.has(id),
      locallyOwnedWithoutHandle
    )) {
      return this.stopOwnedProjectProcess(id, stopProject, options);
    }

    if (stopProject.stopCommand) {
      const confirmed = options.approvedLaunchStop === true
        || await this.confirmCustomStopCommand(stopProject);
      if (!confirmed) {
        return false;
      }
      const hadTrackedOwnership = this.processes.has(id) || Boolean(sharedOwnership?.processActive);
      const customStopResult = await this.runCustomStopCommand(stopProject);
      const hasConfiguredServices = Boolean(stopProject.services?.length);
      let remainingOwnership = this.processOwnership.snapshot().get(id);
      let stillOwned = this.processes.has(id) || Boolean(remainingOwnership?.processActive);
      let ownershipStopped;
      let servicesStopped;
      if (customStopResult.succeeded) {
        [ownershipStopped, servicesStopped] = await Promise.all([
          stillOwned
            ? this.waitForProjectStopCompletion(id, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS)
            : true,
          this.lifecycle.waitUntilServicesStopped(stopProject, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS)
        ]);
      } else {
        servicesStopped = await this.lifecycle.waitUntilServicesStopped(stopProject, 0);
        remainingOwnership = this.processOwnership.snapshot().get(id);
        stillOwned = this.processes.has(id) || Boolean(remainingOwnership?.processActive);
        ownershipStopped = !stillOwned;
      }

      const postcondition = customStopPostcondition({
        commandSucceeded: customStopResult.succeeded,
        hasConfiguredServices,
        hadTrackedOwnership,
        ownershipStopped,
        servicesStopped
      });
      if (postcondition === 'complete') {
        this.finishStopping(id, true);
        return true;
      }
      const remaining = [
        !ownershipStopped ? 'the Runlist-launched process is still active' : '',
        !servicesStopped ? 'one or more configured ports are still open' : ''
      ].filter(Boolean).join(' and ');
      const detail = postcondition === 'command-failed'
        ? customStopResult.detail
        : postcondition === 'unverifiable'
          ? 'the command finished, but this project has no tracked process or configured service ports to verify'
          : `the command finished, but ${remaining}`;
      vscode.window.showErrorMessage(
        `Could not confirm that ${stopProject.name} stopped: ${detail}. Runlist did not run another command or stop any additional process.`
      );
      this.finishStopping(id, false);
      return false;
    }

    return this.stopOwnedProjectProcess(id, stopProject, options);
  }

  async restartProject(id) {
    return this.lifecycle.restart(id);
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
      const savedProject = this.projects.find((candidate) => candidate.id === id);
      const project = projectStopStrategy(
        savedProject,
        this.processOwnership.snapshot().get(id)
      );
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
        await terminateTrackedProcess(this.processes, id, {
          allowMissing: options.allowMissing === true
        });
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
    let environment;
    try {
      environment = projectLaunchEnvironment(
        process.env,
        effectiveProjectPortOverrides(project)
      );
    } catch (error) {
      return Promise.resolve({
        succeeded: false,
        detail: `its temporary port settings are invalid: ${error.message}`
      });
    }
    this.beginStopping(project.id);
    return new Promise((resolve) => {
      const stopProcess = spawn(project.stopCommand, {
        cwd: project.folder,
        env: environment,
        ...customStopSpawnOptions()
      });
      const stopProcessIdentity = readProcessIdentity(stopProcess.pid);
      let finalized = false;
      let stdout = '';
      let stderr = '';
      stopProcess.stdout?.setEncoding('utf8');
      stopProcess.stdout?.on('data', (chunk) => {
        stdout = `${stdout}${chunk}`.slice(-2000);
      });
      stopProcess.stderr?.setEncoding('utf8');
      stopProcess.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      const finalize = (result) => {
        if (finalized) {
          return;
        }
        finalized = true;
        clearTimeout(stopTimeout);
        resolve(result);
      };
      const stopTimeout = setTimeout(() => {
        if (finalized) {
          return;
        }
        finalized = true;
        clearTimeout(stopTimeout);
        void Promise.resolve(stopProcessIdentity)
          .then((expectedIdentity) => {
            if (!expectedIdentity) {
              throw new Error('Runlist could not verify the custom stop process identity.');
            }
            return terminateProcessTree(stopProcess.pid, {
              expectedIdentity,
              readProcessIdentity
            });
          })
          .then(() => {
            resolve({
              succeeded: false,
              detail: 'the custom stop command did not finish.'
            });
          })
          .catch((error) => {
            resolve({
              succeeded: false,
              detail: `the custom stop command did not finish, and Runlist could not clean up its process tree: ${error.message}`
            });
          })
      }, CUSTOM_STOP_TIMEOUT_MS);

      stopProcess.once('error', (error) => {
        finalize({ succeeded: false, detail: error.message });
      });
      stopProcess.once('exit', (code) => {
        finalize({
          succeeded: code === 0,
          detail: code === 0
            ? undefined
            : lastUsefulLine(`${stdout}\n${stderr}`) || `custom stop command exited with code ${code}.`
        });
      });
    });
  }

  async confirmCustomStopCommand(project) {
    const choice = await vscode.window.showWarningMessage(
      `Run the custom Stop command for ${project.name}?`,
      {
        modal: true,
        detail: `This user-controlled command runs in ${project.folder}:\n\n${project.stopCommand}\n\nRunlist will wait up to ${Math.round(CUSTOM_STOP_TIMEOUT_MS / 1000)} seconds, then verify its tracked process and configured ports. It will not retry, rewrite, or fall back to another stop action.`
      },
      'Run custom Stop'
    );
    return choice === 'Run custom Stop';
  }

  stopAllProjects() {
    this.lifecycle.stopAll();
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
    const messageRouterUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'message-router.js')
    );
    const projectActionsUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'project-actions.js')
    );
    const nonce = crypto.randomBytes(16).toString('base64');
    this.webviewMessageToken = nonce;
    const projects = this.projects;
    const tags = projectTagVocabulary(projects);
    if (this.tagFilter && !tags.some((tag) => (
      tag.toLocaleLowerCase() === this.tagFilter.toLocaleLowerCase()
    ))) {
      this.tagFilter = '';
    }
    const outputProject = this.mode === 'output'
      ? projects.find((project) => project.id === this.selectedProjectId)
      : undefined;
    const diagnosisProject = this.mode === 'diagnosis'
      ? projects.find((project) => project.id === this.selectedProjectId)
      : undefined;
    const diagnosisRecord = diagnosisProject
      ? readProjectDiagnostics(this.projectsFile, diagnosisProject.id)
      : undefined;
    const repairProposal = diagnosisProject
      ? readProjectRepairProposal(this.projectsFile, diagnosisProject.id)
      : undefined;
    const repairProposalStale = Boolean(repairProposal && (
      repairProposal.projectRevision !== projectConfigurationRevision(diagnosisProject)
      || repairProposal.projectRevision !== diagnosisRecord?.projectRevision
      || repairProposal.failedAt !== diagnosisRecord?.failedAt
    ));
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
      const runtime = this.projectRuntime.get(project.id);
      const runtimeProject = projectStopStrategy(project, runtime);
      const profiles = launchProfileOptions(project);
      const activeLaunchProfileId = runtime?.launchProfileId
        || selectedLaunchProfileId(project);
      const activeLaunchProfile = profiles.find((profile) => profile.id === activeLaunchProfileId)
        || profiles[0];
      const previewService = projectPreviewService(
        runtimeProject,
        status,
        serviceUrls,
        this.projectPortConflicts.has(project.id)
      );
      const canPreview = Boolean(previewService);
      const timelineVisible = this.projectHasLiveTimeline(project.id, runtimeProject, status);
      const attempt = this.projectAttemptMetadata.get(project.id);
      const failure = this.projectTimelineFailures.get(project.id);
      const timelineAttention = ['not-ready', 'not-responding'].includes(status);
      const commandLaunched = Boolean(runtime?.launchedAt
        || attempt?.launchedAt
        || runtime?.processActive
        || this.processes.has(project.id));
      const timelineStages = serviceTimelineStages({
        services: runtimeProject.services,
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
      const phoneHandoff = previewExpanded
        ? createPhoneHandoff(previewService.url)
        : undefined;
      const outputPeekVisible = detailsExpanded
        && ['starting', 'running', 'not-ready', 'not-responding', 'ownership-lost'].includes(status)
        && (this.managedProjectIds.has(project.id)
          || this.processes.has(project.id)
          || this.projectRuntime.has(project.id));
      const outputPeek = outputPeekVisible
        ? projectOutputPeek(this.projectOutputs.get(project.id))
        : undefined;
      const startupHistory = readStartupHistory(this.projectsFile, project.id);
      const detailTabs = availableProjectDetailTabs({
        servicesAvailable: runtimeProject.services.length > 0,
        outputAvailable: outputPeek !== undefined,
        previewAvailable: previewExpanded,
        historyAvailable: startupHistory.length > 0
      });
      const locallyOwned = this.processes.has(project.id);
      const lifecycleCapability = this.lifecycleCapabilityFor(project);
      return {
        ...runtimeProject,
        launchProfiles: profiles.map((profile) => ({ id: profile.id, name: profile.name })),
        activeLaunchProfileId,
        activeLaunchProfileName: runtime?.launchProfileName || activeLaunchProfile.name,
        launchProfileChangeDisabled: this.projectSetupLocked(project.id),
        stopCommand: typeof runtime?.stopCommand === 'string'
          ? runtime.stopCommand
          : project.stopCommand,
        pinned: project.pinned === true,
        openPorts,
        portConflict: this.projectPortConflicts.get(project.id),
        respondingPorts,
        serviceReadiness: serviceReadinessDetails(
          runtimeProject.services,
          openPorts,
          respondingPorts,
          webPorts
        ),
        serviceUrls,
        status,
        lifecycleBlocked: !lifecycleCapability.supported,
        lifecycleBlockedReason: lifecycleCapability.reason,
        timeline,
        detailsExpanded,
        forceClosing: this.forceClosingProjectIds.has(project.id),
        handoffInProgress: this.handoffProjectIds.has(project.id),
        outputPeek,
        timelineExpanded: timelineVisible && detailsExpanded,
        previewExpanded,
        previewPort: previewService?.port,
        previewUrl: previewService?.url,
        phoneHandoff,
        startupHistory,
        averageReadyDurationMs: averageReadyDuration(startupHistory),
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
        httpResponsePulse: previewExpanded
          ? this.httpResponseHistory.get(project.id)
          : undefined,
        detailTabs,
        defaultDetailTab: preferredProjectDetailTab(detailTabs),
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
      this.syncHttpResponsePulseTarget(undefined, undefined, undefined);
      this.focusTarget = { type: 'project-control', id: previousId };
    }
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const stoppableIds = new Set(stoppableProjectIds(stateProjects));
    const groups = this.groups.map((group) => {
      const progress = this.runGroupStates.get(group.id);
      return {
        ...group,
        busy: progress?.busy === true,
        canStop: group.projectIds.some((id) => stoppableIds.has(id)),
        lifecycleBlocked: group.projectIds.some((id) => {
          const project = projectsById.get(id);
          return project && !this.lifecycleCapabilityFor(project).supported;
        }),
        memberNames: group.projectIds.map((id) => projectsById.get(id)?.name || 'Missing project'),
        progress: progress?.message
      };
    });
    const state = {
      agentConnections: this.agentConnections,
      messageToken: nonce,
      mode: this.mode,
      searchQuery: this.searchQuery,
      tagFilter: this.tagFilter,
      tags,
      draft: this.draft,
      canUseCurrentWorkspace: this.mode === 'add'
        && canUseCurrentWorkspace(vscode.workspace.workspaceFolders),
      focusTarget: this.focusTarget || this.lastFocusTarget,
      formErrors: this.formErrors,
      groups,
      reviewRequired: this.mode === 'edit'
        && Boolean(projects.find((project) => project.id === this.selectedProjectId)?.reviewRequired),
      servicesLocked: this.mode === 'edit'
        && this.projectSetupLocked(this.selectedProjectId),
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
        approved: this.approvedRepairProjectId === diagnosisProject.id,
        name: diagnosisProject.name,
        outputAvailable: Boolean(diagnosisRecord.retainedOutput),
        outputTruncated: diagnosisRecord.outputTruncated === true,
        projectId: diagnosisProject.id,
        repair: repairProposal ? {
          comparison: projectRepairComparison(diagnosisProject, repairProposal.proposedProject),
          stale: repairProposalStale
        } : undefined
      } : undefined,
      projects: stateProjects,
      runningAppIds: runningAppProjectIds(stateProjects),
      stopAllCount: stoppableProjectIds(stateProjects).length
    };
    const expandedPreview = stateProjects.find((project) => project.previewExpanded);
    const runningAppIdSet = new Set(state.runningAppIds.map(String));
    const frameSources = previewFrameSources([
      expandedPreview?.previewUrl,
      ...stateProjects
        .filter((project) => runningAppIdSet.has(String(project.id)))
        .map((project) => project.previewUrl)
    ]);

    this.view.webview.html = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view.webview.cspSource}; script-src 'nonce-${nonce}'; frame-src ${frameSources};">
          <link rel="stylesheet" href="${stylesUri}">
          <title>Runlist</title>
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}" src="${messageRouterUri}"></script>
          <script nonce="${nonce}" src="${projectActionsUri}"></script>
          <script nonce="${nonce}">window.runlistState = ${safeJson(state)};</script>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>`;
    this.focusTarget = undefined;
    this.syncResourceSampling(expandedPreview?.id);
    this.syncHttpResponsePulseTarget(
      expandedPreview?.id,
      expandedPreview?.previewPort,
      expandedPreview?.previewUrl
    );
  }

  dispose() {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.lifecycle.beginShutdown();
    this.stopResourceSampling();

    this.shutdownPromise = (async () => {
      for (const id of [...this.startAttempts.keys()]) {
        if (!this.processes.has(id)) {
          this.processOwnership.release(id);
          this.releaseStartReservation(id);
        }
      }

      await this.lifecycle.waitForIdle();
      const ownership = this.processOwnership.snapshot();
      await Promise.allSettled([...this.processes.keys()].map((id) => {
        const persisted = ownership.get(id);
        const savedProject = this.projects.find((project) => project.id === id);
        const project = projectStopStrategy(savedProject || {
          id,
          name: 'this project',
          folder: persisted?.cwd,
          stopCommand: persisted?.stopCommand || ''
        }, persisted);
        if (!project?.stopCommand) {
          return undefined;
        }
        return this.lifecycle.stop(id, { ...project, reviewRequired: false }, {
          approvedLaunchStop: true
        });
      }));
      await this.lifecycle.waitForIdle();
      this.runGroupCoordinator.dispose();
      return shutdownTrackedProcesses(
        this.processes,
        this.processOwnership,
        this.portReservations
      );
    })();
    return this.shutdownPromise;
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
  if (conflict?.kind === 'occupied') {
    return {
      kind: conflict.kind,
      port: conflict.port
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
  for (const key of ['id', 'action', 'agent', 'tab', 'port']) {
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
  const bridgeFiles = [
    'mcp/server.js',
    'src/lifecycle/process-metrics.js',
    'src/lifecycle/project-process.js',
    'src/ports/service-port-overrides.js',
    'src/projects/launch-profile.js',
    'src/projects/project-output.js',
    'src/projects/project-diagnostics.js',
    'src/projects/project-repair.js',
    'src/projects/project-store.js',
    'src/projects/project-tags.js',
    'src/services/external-url.js',
    'package.json'
  ];
  for (const relativePath of bridgeFiles) {
    const targetPath = path.join(storageRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(
      vscode.Uri.joinPath(context.extensionUri, ...relativePath.split('/')).fsPath,
      targetPath
    );
  }
  return serverPath;
}

let activeProvider;

function activate(context) {
  const projectsFile = path.join(context.globalStorageUri.fsPath, 'projects.json');
  try {
    initializeProjectStore(projectsFile, context.globalState.get(STORAGE_KEY, []));
  } catch (error) {
    if (error instanceof ProjectStoreError) {
      void vscode.window.showErrorMessage(error.message);
    }
    throw error;
  }

  const serverPath = installMcpBridge(context);
  const provider = new RunlistViewProvider(context, projectsFile, serverPath);
  activeProvider = provider;
  context.subscriptions.push({ dispose: () => { void provider.dispose(); } });
  const handleProjectStoreChange = () => provider.handleProjectStoreChange();
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
    vscode.commands.registerCommand('runlist.transferProjects', () => provider.showProjectTransfer()),
    vscode.commands.registerCommand('runlist.manageGroups', () => provider.showRunGroupManager()),
    vscode.lm.registerMcpServerDefinitionProvider('runlist.projects', {
      provideMcpServerDefinitions: () => [mcpDefinition],
      resolveMcpServerDefinition: (server) => server
    }),
    provider.startStatusMonitoring(),
    { dispose: () => fs.unwatchFile(projectsFile, handleProjectStoreChange) }
  );

  if (process.env.RUNLIST_EXTENSION_SMOKE === '1') {
    return { projectsFile, provider };
  }
}

function formatPortList(ports) {
  return (ports || []).map((port) => `:${port}`).join(', ') || 'the configured ports';
}

function deactivate() {
  const provider = activeProvider;
  activeProvider = undefined;
  return provider?.dispose();
}

module.exports = { activate, deactivate };
