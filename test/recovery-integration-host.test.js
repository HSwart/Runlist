const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertProject, upsertRunGroup } = require('../src/projects/project-store');
const { runlistTerminalName } = require('../src/lifecycle/runlist-terminal');

function createVscodeMock() {
  const terminals = [];
  const messages = [];
  const clipboard = [];
  const vscode = {
    EventEmitter: class {
      constructor() {
        this.listeners = [];
      }
      get event() {
        return (listener) => {
          this.listeners.push(listener);
          return { dispose: () => {} };
        };
      }
      fire(value) {
        for (const listener of this.listeners) {
          listener(value);
        }
      }
    },
    env: {
      remoteName: undefined,
      clipboard: {
        writeText: async (value) => {
          clipboard.push(value);
        }
      }
    },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage(message, ...actions) {
        messages.push({ type: 'error', message, actions });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message, options, ...actions) {
        messages.push({
          type: 'warning',
          message,
          detail: options?.detail,
          actions: actions.length ? actions : (options?.modal ? [] : [options])
        });
        return Promise.resolve(undefined);
      },
      showInformationMessage(message) {
        messages.push({ type: 'information', message });
        return Promise.resolve(undefined);
      },
      createTerminal: (options) => {
        const term = {
          options,
          showCalls: [],
          show(preserveFocus) {
            this.showCalls.push(preserveFocus);
          },
          dispose() {}
        };
        terminals.push(term);
        return term;
      }
    },
    commands: {
      executeCommand: async () => {}
    },
    workspace: { workspaceFolders: [] },
    extensions: { getExtension: () => undefined }
  };
  return { clipboard, messages, terminals, vscode };
}

function loadRunlistProvider(vscode) {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
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

function providerFixture(t, vscodeOverrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-recovery-host-'));
  const projectsFile = path.join(tempRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '[]\n');
  const mocks = createVscodeMock();
  Object.assign(mocks.vscode.window, vscodeOverrides.window || {});
  Object.assign(mocks.vscode.env, vscodeOverrides.env || {});
  const Provider = loadRunlistProvider(mocks.vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  provider.render = () => {};
  provider.renderProjectList = () => {};
  provider.view = { webview: { postMessage() {} } };
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return { ...mocks, projectsFile, provider, tempRoot };
}

test('showProjectTerminal focuses the existing run terminal session', async (t) => {
  const { provider, terminals } = providerFixture(t);
  const folder = path.join(provider.projectsFile, '..', 'api');
  fs.mkdirSync(folder, { recursive: true });
  const resolvedFolder = fs.realpathSync(folder);
  const project = upsertProject(provider.projectsFile, {
    name: 'API',
    folder: resolvedFolder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  provider.projects = [project];
  provider.ensureRunlistTerminal(project.id, project, { PORT: '3000' });

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].options.name, runlistTerminalName('API'));
  assert.equal(terminals[0].options.cwd, resolvedFolder);
  terminals[0].showCalls = [];

  await provider.showProjectTerminal(project.id);

  assert.deepEqual(terminals[0].showCalls, [false]);
});

test('showProjectTerminal opens a blank folder terminal after the run tab closes', async (t) => {
  const { provider, terminals } = providerFixture(t);
  const folder = path.join(provider.projectsFile, '..', 'api');
  fs.mkdirSync(folder, { recursive: true });
  const resolvedFolder = fs.realpathSync(folder);
  const project = upsertProject(provider.projectsFile, {
    name: 'API',
    folder: resolvedFolder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  provider.projects = [project];
  provider.ensureRunlistTerminal(project.id, project, {});
  assert.equal(provider.projectRunTerminals.has(project.id), true);
  terminals[0].options.pty.close();
  assert.equal(provider.projectRunTerminals.has(project.id), false);
  terminals.length = 0;

  await provider.showProjectTerminal(project.id);

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].options.name, undefined);
  assert.equal(terminals[0].options.cwd, resolvedFolder);
});

test('addProjectOutput mirrors captured chunks into the run terminal', async (t) => {
  const { provider, terminals } = providerFixture(t);
  const folder = path.join(provider.projectsFile, '..', 'api');
  fs.mkdirSync(folder);
  const project = upsertProject(provider.projectsFile, {
    name: 'API',
    folder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  provider.projects = [project];
  provider.ensureRunlistTerminal(project.id, project, {});
  const writes = [];
  terminals[0].options.pty.onDidWrite((chunk) => writes.push(chunk));

  provider.addProjectOutput(project.id, 'listening on 3000\n');

  assert.deepEqual(writes, ['listening on 3000\n']);
});

test('stopSavedRunGroup requires modal confirmation before stopping', async (t) => {
  const { messages, projectsFile, provider } = providerFixture(t);
  const folderA = path.join(projectsFile, '..', 'a');
  const folderB = path.join(projectsFile, '..', 'b');
  fs.mkdirSync(folderA);
  fs.mkdirSync(folderB);
  const projectA = upsertProject(projectsFile, {
    name: 'API',
    folder: folderA,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  const projectB = upsertProject(projectsFile, {
    name: 'Web',
    folder: folderB,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  const { group } = upsertRunGroup(projectsFile, {
    name: 'Stack',
    projectIds: [projectA.id, projectB.id]
  });
  provider.projects = [projectA, projectB];
  provider.projectStatuses.set(projectA.id, 'running');
  provider.projectStatuses.set(projectB.id, 'running');
  let stopGroupCalls = 0;
  provider.lifecycle.stopGroup = async () => {
    stopGroupCalls += 1;
    return true;
  };

  const cancelled = await provider.stopSavedRunGroup(group.id);

  assert.equal(cancelled, false);
  assert.equal(stopGroupCalls, 0);
  assert.equal(messages.some((entry) => entry.type === 'warning' && entry.message === 'Stop group Stack?'), true);
  assert.match(messages.find((entry) => entry.type === 'warning')?.detail || '', /API/);
});

test('stopSavedRunGroup stops after the user confirms', async (t) => {
  let confirmChoice;
  const { projectsFile, provider } = providerFixture(t, {
    window: {
      showWarningMessage(message, options, ...actions) {
        confirmChoice = actions[0];
        return Promise.resolve(actions[0]);
      }
    }
  });
  const folder = path.join(projectsFile, '..', 'api');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'API',
    folder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  const { group } = upsertRunGroup(projectsFile, {
    name: 'Stack',
    projectIds: [project.id]
  });
  provider.projects = [project];
  provider.projectStatuses.set(project.id, 'running');
  let stopGroupCalls = 0;
  provider.lifecycle.stopGroup = async () => {
    stopGroupCalls += 1;
    return true;
  };

  const stopped = await provider.stopSavedRunGroup(group.id);

  assert.equal(confirmChoice, 'Stop group');
  assert.equal(stopped, true);
  assert.equal(stopGroupCalls, 1);
});

test('copyProjectFailure copies a redacted start failure to the clipboard', async (t) => {
  const { clipboard, messages, provider } = providerFixture(t);
  const folder = path.join(provider.projectsFile, '..', 'api');
  fs.mkdirSync(folder);
  const project = upsertProject(provider.projectsFile, {
    name: 'API',
    folder,
    startCommand: 'npm start',
    services: []
  }, { reviewRequired: false }).project;
  provider.projects = [project];
  provider.projectStatuses.set(project.id, 'stopped');
  provider.projectFailureSummaries.set(project.id, {
    title: 'Start failed',
    message: 'TOKEN=secret-value'
  });
  provider.projectOutputs.set(project.id, 'Authorization: Bearer abc.def.ghi\n');

  await provider.copyProjectFailure(project.id);

  assert.equal(clipboard.length, 1);
  assert.match(clipboard[0], /Runlist start failed — API/);
  assert.match(clipboard[0], /TOKEN=\[redacted\]/);
  assert.doesNotMatch(clipboard[0], /abc\.def\.ghi/);
  assert.equal(
    messages.some((entry) => entry.type === 'information' && entry.message === 'Copied start error for API.'),
    true
  );
});

test('installed Copilot skill initializes as handoff-ready after reload', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-copilot-skill-'));
  const skillPath = path.join(tempRoot, '.copilot', 'skills', 'runlist', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '<!-- Managed by the Runlist VS Code extension. -->\n# Runlist\n');
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempRoot;
  process.env.USERPROFILE = tempRoot;
  t.after(() => {
    process.env.HOME = originalHome;
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  const { provider } = providerFixture(t);
  assert.equal(provider.agentConnections.copilot.status, 'success');
});
