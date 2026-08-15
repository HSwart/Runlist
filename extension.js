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
  primaryServiceUrl,
  projectStatus,
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
  ownedProcessSpawnOptions,
  terminateTrackedProcess
} = require('./project-process');
const {
  occupiedPortConflict,
  PortReservationStore
} = require('./port-gate');
const {
  projectFormChanged,
  projectFormServices,
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
const STARTING_DISPLAY_MS = 3000;

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
    this.startAttempts = new Map();
    this.projectPortConflicts = new Map();
    this.projectStatuses = new Map();
    this.startGraceUntil = new Map();
    this.stoppingProjectIds = new Set();
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
    const timer = setInterval(() => this.refreshProjectStatuses(), 2000);
    return { dispose: () => clearInterval(timer) };
  }

  async refreshProjectStatuses() {
    if (this.statusRefreshInFlight) {
      return;
    }

    this.statusRefreshInFlight = true;
    const revision = this.statusRevision;
    try {
      const now = Date.now();
      const projects = this.projects;
      const sharedRuntime = this.portReservations.snapshot();
      for (const id of [...this.managedProjectIds]) {
        if (!sharedRuntime.has(id)) {
          terminateTrackedProcess(this.processes, id).catch(() => {});
          this.managedProjectIds.delete(id);
          this.portReservations.release(id);
          this.startGraceUntil.delete(id);
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
        if (portStatus.allOpen) {
          this.startGraceUntil.delete(project.id);
          if (this.managedProjectIds.has(project.id)) {
            this.portReservations.setState(project.id, 'running');
          }
        }
        const sharedState = sharedRuntime.get(project.id);
        const conflict = occupiedPortConflict({
          project,
          projects,
          managedProjectIds,
          openPorts: portStatus.openPorts
        });
        const status = projectStatus({
          ...portStatus,
          ambiguousConflict: conflict?.kind === 'ambiguous',
          hasServices,
          knownConflict: conflict?.kind === 'managed',
          managed: managedProjectIds.has(project.id),
          processActive: this.processes.has(project.id) || sharedState === 'running',
          stopping: this.stoppingProjectIds.has(project.id) || sharedState === 'stopping',
          withinStartGrace: sharedState === 'starting'
            || now < (this.startGraceUntil.get(project.id) || 0)
        });
        return [project.id, status, portConflictSummary(conflict)];
      }));

      if (revision !== this.statusRevision) {
        return;
      }

      for (const [id, status] of checks) {
        if (status === 'stopped') {
          this.managedProjectIds.delete(id);
          this.startGraceUntil.delete(id);
        }
      }

      const nextStatuses = new Map(checks.map(([id, status]) => [id, status]));
      const nextConflicts = new Map(checks
        .filter(([, , conflict]) => conflict)
        .map(([id, , conflict]) => [id, conflict]));
      const changed = nextStatuses.size !== this.projectStatuses.size
        || [...nextStatuses].some(([id, status]) => this.projectStatuses.get(id) !== status)
        || portConflictMapsDiffer(nextConflicts, this.projectPortConflicts);
      this.projectStatuses = nextStatuses;
      this.projectPortConflicts = nextConflicts;
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
        this.stopProject(message.id);
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
      vscode.window.showErrorMessage(`${project.name} does not have a service port to open.`);
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

    const detail = this.processes.has(id)
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
    try {
      await cleanupTrackedProcessForDeletion(
        this.processes,
        id,
        latestProject,
        (approvedProject) => this.stopProject(id, approvedProject)
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
      return;
    }

    removeProject(this.projectsFile, id);
    const remainingProjects = projects.filter((item) => item.id !== id);
    const adjacentProject = remainingProjects[projectIndex] || remainingProjects[projectIndex - 1];
    this.managedProjectIds.delete(id);
    this.statusRevision += 1;
    this.portReservations.releaseShared(id);
    this.releaseStartReservation(id);
    this.projectStatuses.delete(id);
    this.projectPortConflicts.delete(id);
    this.startGraceUntil.delete(id);
    this.stoppingProjectIds.delete(id);
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
  }

  releaseStartReservation(id) {
    this.startAttempts.delete(id);
    this.portReservations.release(id);
  }

  async startProject(id) {
    const projects = this.projects;
    const project = projects.find((item) => item.id === id);
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

    const reservationConflict = this.portReservations.reserve(project);
    if (reservationConflict) {
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
      this.projectStatuses.set(id, 'starting');
      this.startGraceUntil.set(id, Date.now() + STARTING_DISPLAY_MS);
      this.projectOutputs.set(id, '');
      const child = spawn(project.startCommand, {
        cwd: project.folder,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        ...ownedProcessSpawnOptions()
      });

      this.processes.set(id, child);
      this.startAttempts.delete(id);
      this.portReservations.setState(id, 'running');
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
        this.portReservations.releaseShared(id);
        this.releaseStartReservation(id);
        this.projectStatuses.set(id, 'stopped');
        this.startGraceUntil.delete(id);
        this.addProjectOutput(id, `Switchboard could not start this project: ${error.message}\n`);
        vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
        this.renderProjectList();
      });
      child.once('exit', (code) => {
        if (this.processes.get(id) === child) {
          this.statusRevision += 1;
          this.processes.delete(id);
          if (code !== 0) {
            this.managedProjectIds.delete(id);
            this.portReservations.releaseShared(id);
            this.releaseStartReservation(id);
            this.projectStatuses.set(id, 'stopped');
            this.startGraceUntil.delete(id);
            const detail = lastUsefulLine(stderr);
            vscode.window.showErrorMessage(
              `Could not start ${project.name}: ${detail || `command exited with code ${code}.`}`
            );
            this.renderProjectList();
          } else {
            this.startGraceUntil.delete(id);
            this.projectStatuses.set(id, 'running');
            this.renderProjectList();
          }
          this.refreshProjectStatuses();
        }
      });
      this.renderProjectList();
    } catch (error) {
      this.statusRevision += 1;
      this.managedProjectIds.delete(id);
      this.portReservations.releaseShared(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, 'stopped');
      this.startGraceUntil.delete(id);
      vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
      this.renderProjectList();
    }
  }

  stopProject(id, projectSnapshot) {
    const project = projectSnapshot || this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }
    if (project.reviewRequired) {
      vscode.window.showWarningMessage(`Review and approve ${project.name}'s setup before running its commands.`);
      this.showEditProject(id);
      return;
    }

    if (this.startAttempts.has(id)) {
      this.statusRevision += 1;
      this.portReservations.releaseShared(id);
      this.releaseStartReservation(id);
      this.projectStatuses.set(id, 'stopped');
      this.renderProjectList();
      return;
    }

    if (this.getProjectStatus(id) === 'stopping') {
      return;
    }

    this.stoppingProjectIds.add(id);
    this.portReservations.setState(id, 'stopping');
    this.statusRevision += 1;
    this.projectStatuses.set(id, 'stopping');
    this.startGraceUntil.delete(id);

    let finalized = false;
    const finalizeStop = (succeeded) => {
      if (finalized) {
        return;
      }
      finalized = true;
      this.stoppingProjectIds.delete(id);
      this.statusRevision += 1;
      if (succeeded) {
        this.managedProjectIds.delete(id);
        this.portReservations.releaseShared(id);
        this.releaseStartReservation(id);
      } else {
        this.portReservations.setState(id, 'running');
      }
      this.projectStatuses.set(id, succeeded ? 'stopped' : 'active');
      this.renderProjectList();
      setTimeout(() => this.refreshProjectStatuses(), 250);
    };

    if (!project.stopCommand) {
      if (!this.processes.has(id)) {
        vscode.window.showErrorMessage(
          `Could not stop ${project.name}: Switchboard does not have the process handle from the VS Code window that started it. No process was stopped. Add a custom stop command if the project detaches from its launcher.`
        );
        finalizeStop(false);
        return;
      }
      terminateTrackedProcess(this.processes, id).then(
        () => finalizeStop(true),
        (error) => {
          vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
          finalizeStop(false);
        }
      );
      return;
    }

    const stopProcess = spawn(project.stopCommand, {
      cwd: project.folder,
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env
    });

    let stderr = '';
    stopProcess.stderr?.setEncoding('utf8');
    stopProcess.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    const stopTimeout = setTimeout(() => {
      stopProcess.kill();
      vscode.window.showErrorMessage(`Could not stop ${project.name}: the stop command did not finish.`);
      finalizeStop(false);
    }, 15000);
    const finalizeCustomStop = (succeeded) => {
      clearTimeout(stopTimeout);
      finalizeStop(succeeded);
    };

    stopProcess.once('error', (error) => {
      vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
      finalizeCustomStop(false);
    });
    stopProcess.once('exit', (code) => {
      if (code !== 0) {
        const detail = lastUsefulLine(stderr);
        vscode.window.showErrorMessage(
          `Could not stop ${project.name}: ${detail || `command exited with code ${code}.`}`
        );
      }
      finalizeCustomStop(code === 0);
    });

    terminateTrackedProcess(this.processes, id).catch(() => {});
    this.renderProjectList();
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
    const stateProjects = projects.map((project) => ({
      ...project,
      portConflict: this.projectPortConflicts.get(project.id),
      status: this.getProjectStatus(project.id),
      searchText: projectSearchText(project)
    }));
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
