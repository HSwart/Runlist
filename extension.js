const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { registerWithClaude, registerWithCodex } = require('./agent-registration');
const { areServicesRunning, primaryServiceUrl } = require('./project-status');
const {
  initializeProjectStore,
  readProjects,
  removeProject,
  upsertProject
} = require('./project-store');

const STORAGE_KEY = 'switchboard.projects';

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
    this.runningProjectIds = new Set();
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

  isProjectRunning(id) {
    return !this.stoppingProjectIds.has(id)
      && (this.runningProjectIds.has(id) || this.processes.has(id));
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
      const checks = await Promise.all(this.projects.map(async (project) => {
        if (this.stoppingProjectIds.has(project.id)) {
          return [project.id, false];
        }
        if (!project.services?.length) {
          return [project.id, this.processes.has(project.id)];
        }

        const portsAreOpen = await areServicesRunning(project.services);
        if (portsAreOpen) {
          this.startGraceUntil.delete(project.id);
        }
        const isStarting = now < (this.startGraceUntil.get(project.id) || 0);
        return [project.id, portsAreOpen || (isStarting && this.runningProjectIds.has(project.id))];
      }));

      const nextRunningIds = new Set(checks.filter(([, running]) => running).map(([id]) => id));
      const changed = nextRunningIds.size !== this.runningProjectIds.size
        || [...nextRunningIds].some((id) => !this.runningProjectIds.has(id));
      this.runningProjectIds = nextRunningIds;
      if (changed) {
        this.render();
      }
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

    if (!folder || !startCommand || !stopCommand) {
      vscode.window.showErrorMessage('Choose a project folder and enter both commands.');
      return;
    }

    try {
      upsertProject(this.projectsFile, {
        id: this.selectedProjectId,
        folder,
        startCommand,
        stopCommand
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
    this.mode = 'list';
    this.draft = {};
    this.selectedProjectId = undefined;
    this.render();
  }

  startProject(id) {
    if (this.isProjectRunning(id)) {
      return;
    }

    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    try {
      this.runningProjectIds.add(id);
      this.startGraceUntil.set(id, Date.now() + 15000);
      const child = spawn(project.startCommand, {
        cwd: project.folder,
        shell: true,
        stdio: 'ignore',
        env: process.env
      });

      this.processes.set(id, child);
      child.once('error', (error) => {
        this.processes.delete(id);
        this.runningProjectIds.delete(id);
        this.startGraceUntil.delete(id);
        vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
        this.render();
      });
      child.once('exit', (code) => {
        if (this.processes.get(id) === child) {
          this.processes.delete(id);
          if (code !== 0) {
            this.runningProjectIds.delete(id);
            this.startGraceUntil.delete(id);
            vscode.window.showErrorMessage(`Could not start ${project.name}: command exited with code ${code}.`);
            this.render();
          }
          this.refreshProjectStatuses();
        }
      });
      this.render();
    } catch (error) {
      this.runningProjectIds.delete(id);
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

    this.stoppingProjectIds.add(id);
    this.runningProjectIds.delete(id);
    this.startGraceUntil.delete(id);

    const stopProcess = spawn(project.stopCommand, {
      cwd: project.folder,
      shell: true,
      stdio: 'ignore',
      env: process.env
    });

    let finalized = false;
    const finalizeStop = () => {
      if (finalized) {
        return;
      }
      finalized = true;
      this.stoppingProjectIds.delete(id);
      setTimeout(() => this.refreshProjectStatuses(), 250);
    };

    stopProcess.once('error', (error) => {
      vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
      finalizeStop();
    });
    stopProcess.once('exit', finalizeStop);

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
        running: this.isProjectRunning(project.id)
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

function registrationErrorMessage(clientLabel, error) {
  if (error.code === 'ENOENT') {
    return `${clientLabel} is not installed or its CLI is unavailable on PATH.`;
  }

  const lines = String(error.message || 'Registration failed.')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = lines.at(-1) || 'Registration failed.';
  return detail.length > 240 ? `${detail.slice(0, 237)}…` : detail;
}

function activate(context) {
  const projectsFile = path.join(context.globalStorageUri.fsPath, 'projects.json');
  initializeProjectStore(projectsFile, context.globalState.get(STORAGE_KEY, []));

  const serverPath = vscode.Uri.joinPath(context.extensionUri, 'mcp', 'server.js').fsPath;
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
  mcpDefinition.cwd = context.extensionUri;

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
