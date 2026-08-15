const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  claudeBundledCliPaths,
  codexBundledCliPath,
  registerWithClaude,
  registerWithCodex
} = require('./agent-registration');
const {
  primaryServiceUrl,
  projectStatus,
  servicePortStatus
} = require('./project-status');
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
    this.draft = {};
    this.selectedProjectId = undefined;
    this.processes = new Map();
    this.managedProjectIds = new Set();
    this.projectStatuses = new Map();
    this.startGraceUntil = new Map();
    this.stoppingProjectIds = new Set();
    this.statusRefreshInFlight = false;
    this.agentConnections = {
      claude: { status: 'idle', message: '' },
      codex: { status: 'idle', message: '' }
    };
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

  showAddProject() {
    this.mode = 'add';
    this.draft = {};
    this.selectedProjectId = undefined;
    this.view?.show?.(true);
    this.render();
  }

  showAgentSetup() {
    this.mode = 'agents';
    this.draft = {};
    this.selectedProjectId = undefined;
    this.view?.show?.(true);
    this.render();
  }

  get projects() {
    return readProjects(this.projectsFile);
  }

  getProjectStatus(id) {
    if (this.stoppingProjectIds.has(id)) {
      return 'stopping';
    }
    return this.projectStatuses.get(id)
      || (this.processes.has(id) ? 'running' : 'stopped');
  }

  isProjectRunning(id) {
    return ['running', 'active'].includes(this.getProjectStatus(id));
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
    try {
      const now = Date.now();
      const projects = this.projects;
      const managedPorts = new Set(projects
        .filter((project) => this.managedProjectIds.has(project.id))
        .flatMap((project) => project.services || [])
        .map((service) => service.port));
      const checks = await Promise.all(projects.map(async (project) => {
        const hasServices = Boolean(project.services?.length);
        const portStatus = hasServices
          ? await servicePortStatus(project.services)
          : { allOpen: false, anyOpen: false, openPorts: [] };
        if (portStatus.allOpen) {
          this.startGraceUntil.delete(project.id);
        }
        const status = projectStatus({
          ...portStatus,
          hasServices,
          knownConflict: !this.managedProjectIds.has(project.id)
            && portStatus.openPorts.some((port) => managedPorts.has(port)),
          managed: this.managedProjectIds.has(project.id),
          processActive: this.processes.has(project.id),
          stopping: this.stoppingProjectIds.has(project.id),
          withinStartGrace: now < (this.startGraceUntil.get(project.id) || 0)
        });
        if (status === 'stopped') {
          this.managedProjectIds.delete(project.id);
          this.startGraceUntil.delete(project.id);
        }
        return [project.id, status];
      }));

      const nextStatuses = new Map(checks);
      const changed = nextStatuses.size !== this.projectStatuses.size
        || [...nextStatuses].some(([id, status]) => this.projectStatuses.get(id) !== status);
      this.projectStatuses = nextStatuses;
      if (changed) {
        this.render();
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
        this.mode = 'add';
        this.draft = {};
        this.selectedProjectId = undefined;
        this.render();
        break;
      case 'closeScreen':
        this.mode = 'list';
        this.draft = {};
        this.selectedProjectId = undefined;
        this.render();
        break;
      case 'showEdit':
        this.showEditProject(message.id);
        break;
      case 'pickFolder':
        await this.pickFolder(message.draft);
        break;
      case 'saveProject':
        await this.saveProject(message.project);
        break;
      case 'startProject':
        this.startProject(message.id);
        break;
      case 'stopProject':
        this.stopProject(message.id);
        break;
      case 'openProject':
        await this.openProject(message.id);
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
      claude: {
        label: 'Claude Code',
        register: registerWithClaude,
        success: 'Registered for every Claude Code project. Restart Claude Code and use /mcp to confirm.'
      },
      codex: {
        label: 'Codex',
        register: registerWithCodex,
        success: 'Registered with Codex. Restart Codex and use /mcp to confirm.'
      }
    };
    const registration = registrations[agent];
    if (!registration || this.agentConnections[agent].status === 'loading') {
      return;
    }

    this.agentConnections[agent] = {
      status: 'loading',
      message: `Registering with ${registration.label}…`
    };
    this.render();

    try {
      await registration.register({
        bundledCliPaths: installedClaudeCliPaths(),
        bundledCliPath: installedCodexCliPath(),
        environment: process.env,
        platform: process.platform,
        projectsFile: this.projectsFile,
        runtimePath: process.execPath,
        serverPath: this.serverPath
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
    this.render();
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
      this.render();
    }
  }

  async saveProject(project) {
    const folder = project.folder?.trim();
    const startCommand = project.startCommand?.trim();
    const stopCommand = project.stopCommand?.trim();
    const appPortText = String(project.appPort || '').trim();

    if (!folder || !startCommand || !stopCommand) {
      vscode.window.showErrorMessage('Choose a project folder and enter both commands.');
      return;
    }
    const appPort = appPortText ? Number(appPortText) : undefined;
    if (appPort !== undefined && (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535)) {
      vscode.window.showErrorMessage('App port must be a whole number from 1 to 65535.');
      return;
    }

    try {
      const existing = this.selectedProjectId
        ? this.projects.find((item) => item.id === this.selectedProjectId)
        : undefined;
      const services = appPort === undefined
        ? undefined
        : updatePrimaryService(existing?.services, appPort);
      upsertProject(this.projectsFile, {
        id: this.selectedProjectId,
        folder,
        startCommand,
        stopCommand,
        ...(services ? { services } : {})
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Could not save the project: ${error.message}`);
      return;
    }

    this.mode = 'list';
    this.draft = {};
    this.selectedProjectId = undefined;
    this.render();
  }

  async deleteProject(id) {
    const project = this.projects.find((item) => item.id === id);
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
      return;
    }

    if (this.processes.has(id)) {
      this.stopProject(id);
    }

    removeProject(this.projectsFile, id);
    this.managedProjectIds.delete(id);
    this.projectStatuses.delete(id);
    this.startGraceUntil.delete(id);
    this.stoppingProjectIds.delete(id);
    this.mode = 'list';
    this.draft = {};
    this.selectedProjectId = undefined;
    this.render();
  }

  startProject(id) {
    const currentStatus = this.getProjectStatus(id);
    if (currentStatus !== 'stopped') {
      if (currentStatus === 'port-in-use') {
        vscode.window.showWarningMessage('A configured app port is already in use. Stop that app before starting this project.');
      }
      return;
    }

    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }
    const conflictingProject = this.projects.find((item) => item.id !== id
      && this.managedProjectIds.has(item.id)
      && item.services?.some((service) => project.services?.some((own) => own.port === service.port)));
    if (conflictingProject) {
      vscode.window.showWarningMessage(
        `${conflictingProject.name} uses the same app port. Stop it before starting ${project.name}.`
      );
      return;
    }

    try {
      this.managedProjectIds.add(id);
      this.projectStatuses.set(id, 'starting');
      this.startGraceUntil.set(id, Date.now() + STARTING_DISPLAY_MS);
      const child = spawn(project.startCommand, {
        cwd: project.folder,
        shell: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: process.env
      });

      this.processes.set(id, child);
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      child.once('error', (error) => {
        this.processes.delete(id);
        this.managedProjectIds.delete(id);
        this.projectStatuses.set(id, 'stopped');
        this.startGraceUntil.delete(id);
        vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
        this.render();
      });
      child.once('exit', (code) => {
        if (this.processes.get(id) === child) {
          this.processes.delete(id);
          if (code !== 0) {
            this.managedProjectIds.delete(id);
            this.projectStatuses.set(id, 'stopped');
            this.startGraceUntil.delete(id);
            const detail = lastUsefulLine(stderr);
            vscode.window.showErrorMessage(
              `Could not start ${project.name}: ${detail || `command exited with code ${code}.`}`
            );
            this.render();
          } else {
            this.startGraceUntil.delete(id);
            this.projectStatuses.set(id, 'running');
            this.render();
          }
          this.refreshProjectStatuses();
        }
      });
      this.render();
    } catch (error) {
      this.managedProjectIds.delete(id);
      this.projectStatuses.set(id, 'stopped');
      this.startGraceUntil.delete(id);
      vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
      this.render();
    }
  }

  stopProject(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    if (this.getProjectStatus(id) === 'stopping') {
      return;
    }

    this.stoppingProjectIds.add(id);
    this.projectStatuses.set(id, 'stopping');
    this.startGraceUntil.delete(id);

    const stopProcess = spawn(project.stopCommand, {
      cwd: project.folder,
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env
    });

    let finalized = false;
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
    const finalizeStop = (succeeded) => {
      if (finalized) {
        return;
      }
      finalized = true;
      clearTimeout(stopTimeout);
      this.stoppingProjectIds.delete(id);
      if (succeeded) {
        this.managedProjectIds.delete(id);
      }
      this.projectStatuses.set(id, succeeded ? 'stopped' : 'active');
      this.render();
      setTimeout(() => this.refreshProjectStatuses(), 250);
    };

    stopProcess.once('error', (error) => {
      vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
      finalizeStop(false);
    });
    stopProcess.once('exit', (code) => {
      if (code !== 0) {
        const detail = lastUsefulLine(stderr);
        vscode.window.showErrorMessage(
          `Could not stop ${project.name}: ${detail || `command exited with code ${code}.`}`
        );
      }
      finalizeStop(code === 0);
    });

    this.processes.get(id)?.kill('SIGTERM');
    this.processes.delete(id);
    this.render();
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
    const state = {
      agentConnections: this.agentConnections,
      mode: this.mode,
      draft: this.draft,
      projects: this.projects.map((project) => ({
        ...project,
        status: this.getProjectStatus(project.id)
      }))
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
  }
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function installedCodexCliPath() {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  return codexBundledCliPath(extension?.extensionPath);
}

function installedClaudeCliPaths() {
  const extension = vscode.extensions.getExtension('Anthropic.claude-code');
  return claudeBundledCliPaths(extension?.extensionPath);
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

function updatePrimaryService(existingServices, port) {
  if (!existingServices?.length) {
    return [{ name: 'app', port }];
  }
  return existingServices.map((service, index) => index === 0 ? { ...service, port } : service);
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
  const handleProjectStoreChange = () => provider.render();
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
