const vscode = require('vscode');
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
  isPrimaryServiceOpen,
  primaryServiceUrl,
  projectStatus,
  serviceReadinessTimedOut,
  servicePortStatus,
  stoppableProjectIds
} = require('./project-status');
const { openProjectInNewWindow } = require('./project-navigation');
const {
  canUseCurrentWorkspace,
  selectCurrentWorkspaceFolder
} = require('./project-workspace');
const {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  ProcessOwnershipStore,
  projectProcessSpawnOptions,
  restartProjectSafely,
  terminateTrackedProcess
} = require('./project-process');
const {
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
  sanitizeProjectOutput
} = require('./project-output');
const { projectSearchText } = require('./project-search');
const {
  initializeProjectStore,
  readProjects,
  removeProject,
  upsertProject
} = require('./project-store');

const STORAGE_KEY = 'switchboard.projects';
const START_READINESS_TIMEOUT_MS = 30000;
const STATUS_POLL_INTERVAL_MS = 2000;
const CUSTOM_STOP_TIMEOUT_MS = 15000;
const REMOTE_STOP_TIMEOUT_MS = CUSTOM_STOP_TIMEOUT_MS + STATUS_POLL_INTERVAL_MS + 1000;

class SwitchboardViewProvider {
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
    this.processes = new Map();
    this.projectOutputs = new Map();
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
    this.projectStatuses = new Map();
    this.startReadinessDeadlines = new Map();
    this.readinessWarnings = new Set();
    this.restartingProjectIds = new Set();
    this.stoppingProjectIds = new Set();
    this.remoteStopRequests = new Map();
    this.statusRefreshInFlight = false;
    this.statusRevision = 0;
    this.skillSourceDirectory = path.join(context.extensionUri.fsPath, 'skills', 'switchboard');
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
    return readProjects(this.projectsFile);
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
      for (const [id, request] of [...this.remoteStopRequests]) {
        if (processRuntime.get(id)?.state !== 'stopping') {
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
        } else if (now - request.requestedAt >= REMOTE_STOP_TIMEOUT_MS) {
          this.processOwnership.cancelStopRequest(id);
          this.remoteStopRequests.delete(id);
          this.stoppingProjectIds.delete(id);
          vscode.window.showErrorMessage(
            `Could not confirm that ${request.projectName} stopped: its launching VS Code window did not respond. Switchboard left the process ownership unchanged.`
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
        const ownership = processRuntime.get(project.id);
        const readinessDeadline = ownership?.readinessDeadline
          || this.startReadinessDeadlines.get(project.id);
        const readinessTimedOut = hasServices
          && managedProjectIds.has(project.id)
          && serviceReadinessTimedOut(readinessDeadline, portStatus.allOpen, now);
        if (portStatus.allOpen) {
          this.startReadinessDeadlines.delete(project.id);
          this.readinessWarnings.delete(project.id);
          if (this.managedProjectIds.has(project.id)) {
            this.processOwnership.setState(project.id, 'running');
            this.portReservations.setState(project.id, 'running');
          }
        } else if (readinessTimedOut && this.managedProjectIds.has(project.id)) {
          this.processOwnership.setState(project.id, 'not-ready');
          this.portReservations.setState(project.id, 'not-ready');
          this.notifyServiceNotReady(project);
        }
        const sharedState = sharedRuntime.get(project.id);
        const conflict = occupiedPortConflict({
          project,
          projects,
          managedProjectIds,
          openPorts: portStatus.openPorts
        });
        const status = projectStatus({
          allOpen: portStatus.allOpen,
          ambiguousConflict: conflict?.kind === 'ambiguous',
          anyOpen: portStatus.anyOpen,
          hasServices,
          knownConflict: conflict?.kind === 'managed',
          managed: managedProjectIds.has(project.id),
          processActive: this.processes.has(project.id) || ownership?.processActive,
          readinessTimedOut,
          stopping: this.stoppingProjectIds.has(project.id) || sharedState === 'stopping',
        });
        return [
          project.id,
          status,
          portConflictSummary(conflict),
          portStatus.openPorts
        ];
      }));

      if (revision !== this.statusRevision) {
        return;
      }

      for (const [id, status] of checks) {
        if (status === 'stopped') {
          this.managedProjectIds.delete(id);
          this.startReadinessDeadlines.delete(id);
          this.readinessWarnings.delete(id);
        }
      }

      const nextStatuses = new Map(checks.map(([id, status]) => [id, status]));
      const nextConflicts = new Map(checks
        .filter(([, , conflict]) => conflict)
        .map(([id, , conflict]) => [id, conflict]));
      const nextOpenPorts = new Map(checks
        .map(([id, , , openPorts]) => [id, openPorts]));
      const changed = nextStatuses.size !== this.projectStatuses.size
        || [...nextStatuses].some(([id, status]) => this.projectStatuses.get(id) !== status)
        || portConflictMapsDiffer(nextConflicts, this.projectPortConflicts)
        || [...nextOpenPorts]
          .some(([id, openPorts]) => String(this.projectOpenPorts.get(id)) !== String(openPorts));
      this.projectStatuses = nextStatuses;
      this.projectPortConflicts = nextConflicts;
      this.projectOpenPorts = nextOpenPorts;
      if (changed) {
        this.renderProjectList();
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not refresh Switchboard status: ${error.message}`);
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
      case 'stopAllProjects':
        this.stopAllProjects();
        break;
      case 'openProject':
        await this.openProject(message.id);
        break;
      case 'openProjectFolder':
        await this.openProjectFolder(message.id);
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
        success: 'Skill installed. Use /switchboard in Copilot CLI, or ask Copilot agent mode to set up this project.'
      },
      claude: {
        label: 'Claude Code',
        register: registerWithClaude,
        success: 'Connection and skill are ready. Use /switchboard. Restart Claude Code if it was already open and does not detect the skill.'
      },
      codex: {
        label: 'Codex',
        register: registerWithCodex,
        success: 'Connection and skill are ready. Restart Codex, then use $switchboard.'
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
    if (this.mode === 'output' && this.selectedProjectId === id) {
      this.outputUpdateScheduler.schedule(id);
    }
  }

  notifyServiceNotReady(project) {
    if (this.readinessWarnings.has(project.id)) {
      return;
    }
    this.readinessWarnings.add(project.id);
    const seconds = Math.round(START_READINESS_TIMEOUT_MS / 1000);
    const ports = project.services.map((service) => `:${service.port}`).join(', ');
    this.addProjectOutput(
      project.id,
      `Switchboard: configured service ports ${ports} were not all ready within ${seconds} seconds.\n`
    );
    void vscode.window.showWarningMessage(
      `${project.name} is still running, but its configured services were not ready within ${seconds} seconds.`,
      'View output'
    ).then((choice) => {
      if (choice === 'View output') {
        this.showProjectOutput(project.id);
      }
    });
  }

  showStartFailure(project, detail) {
    this.addProjectOutput(project.id, `Switchboard: start failed — ${detail}\n`);
    void vscode.window.showErrorMessage(
      `Could not start ${project.name}: ${detail}`,
      'View output'
    ).then((choice) => {
      if (choice === 'View output') {
        this.showProjectOutput(project.id);
      }
    });
  }

  sendProjectOutput(id) {
    if (this.mode !== 'output' || this.selectedProjectId !== id) {
      return;
    }
    const rawOutput = this.projectOutputs.get(id) || '';
    this.view?.webview.postMessage({
      type: 'projectOutput',
      entries: formatProjectOutput(rawOutput),
      output: sanitizeProjectOutput(rawOutput)
    });
  }

  async copyProjectOutput() {
    const output = sanitizeProjectOutput(this.projectOutputs.get(this.selectedProjectId) || '');
    if (!output) {
      return;
    }
    await vscode.env.clipboard.writeText(output);
    this.view?.webview.postMessage({ type: 'outputCopied' });
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

  async openProject(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }
    if (!this.isProjectRunning(id)) {
      vscode.window.showInformationMessage(`Start ${project.name} before opening it.`);
      return;
    }

    const url = primaryServiceUrl(project.services);
    if (!url) {
      vscode.window.showErrorMessage(`${project.name} does not have a valid service URL to open.`);
      return;
    }

    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) {
      vscode.window.showErrorMessage(`Could not open ${project.name} at ${url}.`);
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
      && ['running', 'starting', 'not-ready', 'stopping', 'active'].includes(this.getProjectStatus(projectId));
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
      ? 'This removes the saved project from Switchboard and stops its running process. Project files are not deleted.'
      : 'This removes the saved project from Switchboard. Project files are not deleted.';
    const choice = await vscode.window.showWarningMessage(
      `Delete ${project.name} from Switchboard?`,
      { modal: true, detail },
      'Delete project'
    );

    if (choice !== 'Delete project') {
      this.view?.webview.postMessage({ type: 'restoreProjectMenuFocus', id });
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
            `Could not delete ${project.name}: Switchboard could not confirm that its launched process stopped.`
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
      this.startReadinessDeadlines.delete(id);
      this.readinessWarnings.delete(id);
      this.stoppingProjectIds.delete(id);
      this.remoteStopRequests.delete(id);
      this.projectOutputs.delete(id);
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

  async waitForProjectStopCompletion(id) {
    const deadline = Date.now() + REMOTE_STOP_TIMEOUT_MS + 1000;
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

  async startProject(id) {
    let projects = this.projects;
    let project = projects.find((item) => item.id === id);
    if (!project) {
      return;
    }
    if (project.reviewRequired) {
      vscode.window.showWarningMessage(`Review and approve ${project.name}'s setup before running its commands.`);
      this.showEditProject(id);
      return;
    }

    const currentStatus = this.getProjectStatus(id);
    if (currentStatus !== 'stopped') {
      if (['port-in-use', 'port-in-use-unknown'].includes(currentStatus)) {
        vscode.window.showWarningMessage('A configured app port is already in use. Stop the running app before starting this project.');
      }
      return;
    }

    const ownershipConflict = this.processOwnership.reserve(id);
    if (ownershipConflict) {
      vscode.window.showWarningMessage(ownershipConflict.kind === 'uncertain'
        ? `Switchboard cannot safely verify who owns ${project.name}'s previous process. Close it manually before starting again.`
        : `${project.name} is already running in another VS Code window.`);
      return;
    }

    projects = this.projects;
    project = projects.find((item) => item.id === id);
    if (!project) {
      this.processOwnership.release(id);
      return;
    }
    if (project.reviewRequired) {
      this.processOwnership.release(id);
      vscode.window.showWarningMessage(`Review and approve ${project.name}'s setup before running its commands.`);
      this.showEditProject(id);
      return;
    }

    const reservationConflict = this.portReservations.reserve(project);
    if (reservationConflict) {
      this.processOwnership.release(id);
      const owner = projects.find((candidate) => candidate.id === reservationConflict.projectId);
      vscode.window.showWarningMessage(
        `${owner?.name || 'Another Switchboard project'} is using port :${reservationConflict.port}. Stop it before starting ${project.name}.`
      );
      return;
    }

    const attempt = Symbol(id);
    this.statusRevision += 1;
    this.startAttempts.set(id, attempt);
    this.projectPortConflicts.delete(id);
    this.projectStatuses.set(id, 'starting');
    this.renderProjectList();

    const portStatus = project.services?.length
      ? await servicePortStatus(project.services)
      : { allOpen: false, anyOpen: false, openPorts: [] };
    if (this.startAttempts.get(id) !== attempt) {
      return;
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
      return;
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
      this.projectOutputs.set(id, '');
      const child = spawn(project.startCommand, {
        cwd: project.folder,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        ...projectProcessSpawnOptions()
      });

      this.processes.set(id, child);
      this.processOwnership.setProcess(id, child.pid, {
        state: hasServices ? 'starting' : 'running',
        readinessDeadline
      });
      this.startAttempts.delete(id);
      this.portReservations.setState(id, hasServices ? 'starting' : 'running');
      this.statusRevision += 1;
      let stderr = '';
      listenToProjectOutput(child, (chunk) => this.addProjectOutput(id, chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      child.once('error', (error) => {
        this.statusRevision += 1;
        this.processes.delete(id);
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
          this.statusRevision += 1;
          this.processes.delete(id);
          this.processOwnership.release(id);
          if (code !== 0) {
            this.managedProjectIds.delete(id);
            this.portReservations.releaseShared(id);
            this.releaseStartReservation(id);
            this.projectStatuses.set(id, 'stopped');
            this.startReadinessDeadlines.delete(id);
            this.readinessWarnings.delete(id);
            if (!stoppedIntentionally) {
              const detail = lastUsefulLine(stderr);
              this.showStartFailure(
                project,
                detail || (signal ? `command was terminated by ${signal}.` : `command exited with code ${code}.`)
              );
            }
            this.renderProjectList();
          } else {
            this.managedProjectIds.delete(id);
            this.portReservations.releaseShared(id);
            this.releaseStartReservation(id);
            this.startReadinessDeadlines.delete(id);
            this.readinessWarnings.delete(id);
            this.projectStatuses.set(id, 'stopped');
            this.renderProjectList();
          }
          this.refreshProjectStatuses();
        }
      });
      this.renderProjectList();
    } catch (error) {
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
    }
  }

  async stopProject(id, projectSnapshot) {
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
    if (project.stopCommand && sharedOwnership && !this.processes.has(id)) {
      return this.stopOwnedProjectProcess(id, project);
    }

    if (project.stopCommand) {
      const customStopSucceeded = await this.runCustomStopCommand(project);
      if (!customStopSucceeded) {
        return false;
      }
      const stillOwned = this.processes.has(id) || this.processOwnership.snapshot().has(id);
      if (stillOwned && !await this.waitForProjectStopCompletion(id)) {
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

    return this.stopOwnedProjectProcess(id, project);
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
        return ['running', 'not-ready', 'active'].includes(this.getProjectStatus(id))
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
    if (this.startAttempts.has(id)) {
      this.processOwnership.release(id);
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

    const request = this.processOwnership.requestStop(id);
    if (request.kind === 'requested') {
      this.remoteStopRequests.set(id, { projectName: project.name, requestedAt: Date.now() });
      this.beginStopping(id);
      return true;
    }
    if (request.kind === 'local') {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: Switchboard lost its tracked process details. The process was left running.`
      );
      return false;
    }
    if (request.kind === 'uncertain') {
      vscode.window.showErrorMessage(
        `Could not stop ${project.name}: its launching VS Code window is unavailable, so Switchboard cannot safely verify the process owner. The process was left running.`
      );
      return false;
    }
    if (options.allowMissing) {
      this.finishStopping(id, true);
      return true;
    }

    vscode.window.showErrorMessage(
      `Could not stop ${project.name}: Switchboard does not own a launched process for it. No process was stopped.`
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
    const nonce = Math.random().toString(36).slice(2);
    const projects = this.projects;
    const outputProject = this.mode === 'output'
      ? projects.find((project) => project.id === this.selectedProjectId)
      : undefined;
    const rawProjectOutput = outputProject
      ? this.projectOutputs.get(outputProject.id) || ''
      : '';
    const cleanProjectOutput = sanitizeProjectOutput(rawProjectOutput);
    const stateProjects = projects.map((project) => {
      const openPorts = this.projectOpenPorts.get(project.id) || [];
      return {
        ...project,
        openPorts,
        portConflict: this.projectPortConflicts.get(project.id),
        primaryServiceOpen: isPrimaryServiceOpen(project.services, openPorts),
        status: this.getProjectStatus(project.id),
        searchText: projectSearchText(project)
      };
    });
    const state = {
      agentConnections: this.agentConnections,
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
        && ['running', 'starting', 'not-ready', 'stopping', 'active']
          .includes(this.getProjectStatus(this.selectedProjectId)),
      projectOutput: outputProject ? {
        entries: formatProjectOutput(rawProjectOutput),
        name: outputProject.name,
        output: cleanProjectOutput
      } : undefined,
      projects: stateProjects,
      stopAllCount: stoppableProjectIds(stateProjects).length
    };

    this.view.webview.html = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view.webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${stylesUri}">
          <title>Switchboard</title>
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.switchboardState = ${safeJson(state)};</script>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>`;
    this.focusTarget = undefined;
  }

  dispose() {
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
    return `Port :${conflict.port} is already in use and is also configured for ${names}. Switchboard cannot safely identify its owner.`;
  }
  return `Port :${conflict?.port || 'unknown'} is already in use. ${project.name} appears to be running already.`;
}

function portConflictSummary(conflict) {
  if (conflict?.kind === 'managed') {
    return {
      kind: conflict.kind,
      ownerName: conflict.owner.name,
      port: conflict.port
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

function portConflictMapsDiffer(left, right) {
  if (left.size !== right.size) {
    return true;
  }
  return [...left].some(([id, conflict]) => {
    const previous = right.get(id);
    return !previous
      || previous.kind !== conflict.kind
      || previous.port !== conflict.port
      || previous.ownerName !== conflict.ownerName
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
        message: `Switchboard skill installed. Use ${skill.invocation}, or select Refresh setup after an extension update.`
      };
    }
    if (skill.status === 'conflict') {
      return {
        status: 'error',
        message: `A different Switchboard skill already exists at ${skill.targetDirectory}. Rename or remove it, then try again.`
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
  return serverPath;
}

function activate(context) {
  const projectsFile = path.join(context.globalStorageUri.fsPath, 'projects.json');
  initializeProjectStore(projectsFile, context.globalState.get(STORAGE_KEY, []));

  const serverPath = installMcpBridge(context);
  const provider = new SwitchboardViewProvider(context, projectsFile, serverPath);
  context.subscriptions.push({ dispose: () => provider.dispose() });
  const handleProjectStoreChange = () => provider.renderProjectList();
  fs.watchFile(projectsFile, { interval: 500 }, handleProjectStoreChange);

  const mcpDefinition = new vscode.McpStdioServerDefinition(
    'Switchboard',
    process.execPath,
    [serverPath],
    {
      ELECTRON_RUN_AS_NODE: '1',
      SWITCHBOARD_PROJECTS_FILE: projectsFile
    },
    context.extension.packageJSON.version
  );
  mcpDefinition.cwd = context.globalStorageUri;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('switchboard.projects', provider),
    vscode.commands.registerCommand('switchboard.addProject', () => provider.showAddProject()),
    vscode.commands.registerCommand('switchboard.showAgentSetup', () => provider.showAgentSetup()),
    vscode.lm.registerMcpServerDefinitionProvider('switchboard.projects', {
      provideMcpServerDefinitions: () => [mcpDefinition],
      resolveMcpServerDefinition: (server) => server
    }),
    provider.startStatusMonitoring(),
    { dispose: () => fs.unwatchFile(projectsFile, handleProjectStoreChange) }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
