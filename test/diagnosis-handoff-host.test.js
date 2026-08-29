const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AGENT_CHAT_COMMAND } = require('../src/integrations/diagnosis-handoff');
const { writeProjectDiagnostics } = require('../src/projects/project-diagnostics');
const { projectConfigurationRevision } = require('../src/projects/project-repair');
const { upsertProject } = require('../src/projects/project-store');

function loadRunlistProvider() {
  const root = path.join(__dirname, '..');
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    env: {
      remoteName: undefined,
      clipboard: { writeText: async () => {} }
    },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage() { return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); }
    },
    commands: {
      executeCommand: async () => {}
    },
    workspace: { workspaceFolders: [] }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    providerModule._compile(source, providerPath);
    return { Provider: providerModule.exports.RunlistViewProvider, vscode };
  } finally {
    Module._load = originalLoad;
  }
}

test('askAgentForDiagnosis opens chat when an agent is connected', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-handoff-'));
  const projectsFile = path.join(tempRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  const { Provider, vscode } = loadRunlistProvider();
  const commands = [];
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
  };
  const clipboard = [];
  vscode.env.clipboard.writeText = async (value) => {
    clipboard.push(value);
  };
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  provider.render = () => {};
  provider.view = { webview: { postMessage() {} } };
  const folder = path.join(tempRoot, 'api');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'API',
    folder,
    startCommand: 'npm start',
    services: [{ name: 'web', port: 3000 }]
  }, { reviewRequired: false }).project;
  const revision = projectConfigurationRevision(project);
  writeProjectDiagnostics(projectsFile, project.id, {
    summary: { message: 'PORT=secret' },
    output: '',
    projectRevision: revision,
    failedAt: 5678
  });
  provider.projects = [project];
  provider.agentConnections.copilot = { status: 'success', message: 'Ready' };
  provider.mode = 'output';
  provider.selectedProjectId = project.id;

  await provider.askAgentForDiagnosis(project.id);

  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], AGENT_CHAT_COMMAND);
  assert.match(commands[0][1].query, /projectId ".*"/);
  assert.match(commands[0][1].query, /PORT=\[redacted\]/);
  assert.equal(commands[0][1].isPartialQuery, true);
  assert.equal(clipboard.length, 0);
  assert.equal(provider.mode, 'output');
  assert.match(provider.agentHandoffNotice, /Sent API failure details to your agent/);
});

test('askAgentForDiagnosis falls back to diagnosis screen when no agent is connected', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-handoff-fallback-'));
  const projectsFile = path.join(tempRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  const { Provider, vscode } = loadRunlistProvider();
  const commands = [];
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
  };
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  provider.render = () => {};
  const folder = path.join(tempRoot, 'api');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'API',
    folder,
    startCommand: 'npm start',
    services: [{ name: 'web', port: 3000 }]
  }, { reviewRequired: false }).project;
  writeProjectDiagnostics(projectsFile, project.id, {
    summary: { message: 'failed' },
    output: '',
    projectRevision: projectConfigurationRevision(project),
    failedAt: 1
  });
  provider.projects = [project];
  provider.mode = 'output';
  provider.selectedProjectId = project.id;
  provider.agentConnections = {
    copilot: { status: 'idle', message: '' },
    codex: { status: 'idle', message: '' },
    claude: { status: 'idle', message: '' }
  };

  await provider.askAgentForDiagnosis(project.id);

  assert.equal(commands.length, 0);
  assert.equal(provider.mode, 'diagnosis');
  assert.equal(provider.selectedProjectId, project.id);
});
