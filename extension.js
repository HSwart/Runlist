const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');

const STORAGE_KEY = 'porter.projects';

class PorterViewProvider {
  constructor(context) {
    this.context = context;
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
    return this.context.globalState.get(STORAGE_KEY, []);
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

    const projects = this.projects;
    const savedProject = {
      id: this.selectedProjectId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(folder),
      folder,
      startCommand,
      stopCommand
    };

    if (this.selectedProjectId) {
      const index = projects.findIndex((item) => item.id === this.selectedProjectId);
      if (index === -1) {
        return;
      }
      projects[index] = savedProject;
    } else {
      projects.push(savedProject);
    }

    await this.context.globalState.update(STORAGE_KEY, projects);
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
      ? 'This removes the saved project from Porter and stops its running process. Project files are not deleted.'
      : 'This removes the saved project from Porter. Project files are not deleted.';
    const choice = await vscode.window.showWarningMessage(
      `Delete ${project.name} from Porter?`,
      { modal: true, detail },
      'Delete project'
    );

    if (choice !== 'Delete project') {
      return;
    }

    if (this.processes.has(id)) {
      this.stopProject(id);
    }

    await this.context.globalState.update(
      STORAGE_KEY,
      this.projects.filter((item) => item.id !== id)
    );
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
          <title>Porter</title>
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.porterState = ${safeJson(state)};</script>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>`;
  }
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function activate(context) {
  const provider = new PorterViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('porter.projects', provider),
    vscode.commands.registerCommand('porter.addProject', () => provider.showAddProject())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
