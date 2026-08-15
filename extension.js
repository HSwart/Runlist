const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  initializeProjectStore,
  readProjects,
  removeProject,
  upsertProject
} = require('./project-store');

const STORAGE_KEY = 'switchboard.projects';

class SwitchboardViewProvider {
  constructor(context, projectsFile) {
    this.context = context;
    this.projectsFile = projectsFile;
    this.view = undefined;
    this.mode = 'list';
    this.draft = {};
    this.selectedProjectId = undefined;
    this.processes = new Map();
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

  get projects() {
    return readProjects(this.projectsFile);
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
      case 'deleteProject':
        await this.deleteProject(message.id);
        break;
    }
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
    if (this.processes.has(id)) {
      return;
    }

    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    try {
      const child = spawn(project.startCommand, {
        cwd: project.folder,
        shell: true,
        stdio: 'ignore',
        env: process.env
      });

      this.processes.set(id, child);
      child.once('error', (error) => {
        this.processes.delete(id);
        vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
        this.render();
      });
      child.once('exit', () => {
        if (this.processes.get(id) === child) {
          this.processes.delete(id);
          this.render();
        }
      });
      this.render();
    } catch (error) {
      vscode.window.showErrorMessage(`Could not start ${project.name}: ${error.message}`);
    }
  }

  stopProject(id) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      return;
    }

    const stopProcess = spawn(project.stopCommand, {
      cwd: project.folder,
      shell: true,
      stdio: 'ignore',
      env: process.env
    });

    stopProcess.once('error', (error) => {
      vscode.window.showErrorMessage(`Could not stop ${project.name}: ${error.message}`);
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
      mode: this.mode,
      draft: this.draft,
      projects: this.projects.map((project) => ({
        ...project,
        running: this.processes.has(project.id)
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

function activate(context) {
  const projectsFile = path.join(context.globalStorageUri.fsPath, 'projects.json');
  initializeProjectStore(projectsFile, context.globalState.get(STORAGE_KEY, []));

  const provider = new SwitchboardViewProvider(context, projectsFile);
  const handleProjectStoreChange = () => provider.render();
  fs.watchFile(projectsFile, { interval: 500 }, handleProjectStoreChange);

  const serverPath = vscode.Uri.joinPath(context.extensionUri, 'mcp', 'server.js').fsPath;
  const mcpDefinition = new vscode.McpStdioServerDefinition(
    'Switchboard',
    process.execPath,
    [serverPath],
    { SWITCHBOARD_PROJECTS_FILE: projectsFile },
    context.extension.packageJSON.version
  );
  mcpDefinition.cwd = context.extensionUri;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('switchboard.projects', provider),
    vscode.commands.registerCommand('switchboard.addProject', () => provider.showAddProject()),
    vscode.lm.registerMcpServerDefinitionProvider('switchboard.projects', {
      provideMcpServerDefinitions: () => [mcpDefinition],
      resolveMcpServerDefinition: (server) => server
    }),
    { dispose: () => fs.unwatchFile(projectsFile, handleProjectStoreChange) }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
