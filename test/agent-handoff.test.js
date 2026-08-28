const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AGENT_CHAT_COMMAND,
  agentConnectionReady,
  buildDiagnosisHandoffPrompt,
  sendDiagnosisToAgentChat
} = require('../src/integrations/agent-handoff');
const { writeProjectDiagnostics } = require('../src/projects/project-diagnostics');
const { upsertProject } = require('../src/projects/project-store');
const { readShippedHostSource } = require('./helpers/extension-source');

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

function createHost(t, extras = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-agent-handoff-'));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'Broken App',
    folder,
    startCommand: 'npm run dev',
    services: []
  }, { reviewRequired: false }).project;
  const commands = [];
  const clipboard = [];
  const posted = [];
  const vscode = {
    env: {
      remoteName: undefined,
      clipboard: {
        writeText: async (value) => {
          clipboard.push(value);
        }
      }
    },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    commands: {
      executeCommand: async (...args) => {
        commands.push(args);
        if (typeof extras.executeCommand === 'function') {
          return extras.executeCommand(...args);
        }
      },
      getCommands: async () => extras.availableCommands || [AGENT_CHAT_COMMAND]
    },
    window: {
      showErrorMessage() {
        return Promise.resolve(undefined);
      },
      showWarningMessage() {
        return Promise.resolve(undefined);
      },
      showInformationMessage() {
        return Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const Provider = loadRunlistProvider(vscode);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.view = {
    webview: {
      html: '',
      postMessage(message) {
        posted.push(message);
      }
    }
  };
  provider.render = () => {};
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    clipboard,
    commands,
    posted,
    project,
    projectsFile,
    provider,
    vscode
  };
}

test('builds a sanitized handoff prompt with project id and failure context', () => {
  const prompt = buildDiagnosisHandoffPrompt({
    project: { id: 'proj-1', name: 'API TOKEN=supersecret' },
    diagnostics: {
      projectRevision: 'a'.repeat(64),
      failedAt: 1_700_000_000_000,
      failureSummary: {
        title: 'Start failed',
        message: 'PASSWORD=hunter2 missing'
      },
      retainedOutput: 'AUTH_TOKEN=should-not-appear'
    }
  });

  assert.match(prompt, /Project ID: proj-1/);
  assert.match(prompt, /runlist_get_project_diagnostics with projectId "proj-1"/);
  assert.match(prompt, new RegExp(`Revision: ${'a'.repeat(64)}`));
  assert.match(prompt, /Failed at: 1700000000000/);
  assert.doesNotMatch(prompt, /supersecret|hunter2|should-not-appear/);
  assert.doesNotMatch(prompt, /AUTH_TOKEN=should-not-appear/);
});

test('treats a successful Copilot, Codex, or Claude setup as connected', () => {
  assert.equal(agentConnectionReady({
    copilot: { status: 'idle' },
    codex: { status: 'error' },
    claude: { status: 'loading' }
  }), false);
  assert.equal(agentConnectionReady({
    copilot: { status: 'success' },
    codex: { status: 'idle' },
    claude: { status: 'idle' }
  }), true);
});

test('opens VS Code chat with the sanitized prompt and degrades when the command is missing', async () => {
  const prompt = 'Diagnose this Runlist start failure for App. Project ID: p1.';
  const calls = [];
  assert.equal(await sendDiagnosisToAgentChat({
    commands: {
      executeCommand: async (...args) => {
        calls.push(args);
      },
      getCommands: async () => [AGENT_CHAT_COMMAND]
    }
  }, prompt), true);
  assert.deepEqual(calls, [[AGENT_CHAT_COMMAND, { query: prompt }]]);

  assert.equal(await sendDiagnosisToAgentChat({
    commands: {
      executeCommand: async () => {
        throw new Error('command not found');
      }
    }
  }, prompt), false);
  assert.equal(await sendDiagnosisToAgentChat({
    commands: {
      executeCommand: async () => {},
      getCommands: async () => ['workbench.action.files.save']
    }
  }, prompt), false);
});

test('Ask your agent sends to chat when an agent is connected and copies when it is not', async (t) => {
  const connected = createHost(t);
  writeProjectDiagnostics(connected.projectsFile, connected.project.id, {
    summary: { title: 'Start failed', message: 'vite: command not found' },
    projectRevision: 'b'.repeat(64),
    failedAt: 42,
    output: 'SECRET=nope'
  });
  connected.provider.agentConnections.copilot = { status: 'success', message: 'Ready' };

  await connected.provider.askProjectAgent(connected.project.id);

  assert.equal(connected.commands.length, 1);
  assert.equal(connected.commands[0][0], AGENT_CHAT_COMMAND);
  assert.match(connected.commands[0][1].query, /Project ID: /);
  assert.match(connected.commands[0][1].query, new RegExp(connected.project.id));
  assert.doesNotMatch(connected.commands[0][1].query, /SECRET=nope|nope/);
  assert.deepEqual(connected.clipboard, []);
  assert.equal(connected.provider.mode, 'diagnosis');
  assert.match(connected.provider.diagnosisHandoffNotice, /Sent Broken App failure details to your agent/);

  const disconnected = createHost(t);
  writeProjectDiagnostics(disconnected.projectsFile, disconnected.project.id, {
    summary: { title: 'Start failed', message: 'missing' },
    output: ''
  });
  disconnected.provider.agentConnections.copilot = { status: 'idle', message: '' };

  await disconnected.provider.askProjectAgent(disconnected.project.id);

  assert.deepEqual(disconnected.commands, []);
  assert.deepEqual(disconnected.clipboard, []);
  assert.equal(disconnected.provider.mode, 'diagnosis');
  assert.equal(disconnected.provider.diagnosisHandoffNotice, undefined);
});

test('falls back to Copy diagnosis request when chat invoke is unavailable', async (t) => {
  const host = createHost(t, { availableCommands: [] });
  writeProjectDiagnostics(host.projectsFile, host.project.id, {
    summary: { title: 'Start failed', message: 'missing' },
    output: ''
  });
  host.provider.agentConnections.claude = { status: 'success', message: 'Ready' };

  await host.provider.askProjectAgent(host.project.id);

  assert.equal(host.commands.length, 0);
  assert.equal(host.clipboard.length, 1);
  assert.match(host.clipboard[0], /Project ID: /);
  assert.equal(host.posted.some((message) => message.type === 'diagnosisRequestCopied'), true);
  assert.equal(host.provider.mode, 'diagnosis');
});

test('copyDiagnosisRequest still writes the clipboard without invoking chat', async (t) => {
  const host = createHost(t);
  writeProjectDiagnostics(host.projectsFile, host.project.id, {
    summary: { title: 'Start failed', message: 'missing' },
    output: ''
  });
  host.provider.selectedProjectId = host.project.id;
  host.provider.agentConnections.copilot = { status: 'success', message: 'Ready' };

  await host.provider.copyDiagnosisRequest();

  assert.deepEqual(host.commands, []);
  assert.equal(host.clipboard.length, 1);
  assert.match(host.clipboard[0], /runlist_get_project_diagnostics/);
});

test('does not send without retained diagnostics or without an explicit ask', async (t) => {
  const host = createHost(t);
  host.provider.agentConnections.copilot = { status: 'success', message: 'Ready' };

  await host.provider.askProjectAgent(host.project.id);

  assert.deepEqual(host.commands, []);
  assert.deepEqual(host.clipboard, []);
  assert.notEqual(host.provider.mode, 'diagnosis');
});

test('skill treats Ask your agent chat handoff as a diagnosis request', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'runlist', 'SKILL.md'), 'utf8');
  assert.match(skill, /Ask your agent/);
  assert.match(skill, /sent into chat/);
  assert.match(skill, /Do not run commands, install dependencies/);
});

test('wires Ask your agent through askAgent instead of a silent copy', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const router = fs.readFileSync(
    path.join(root, 'src', 'webview', 'webview-message-router.js'),
    'utf8'
  );

  assert.match(extension, /async askProjectAgent\(/);
  assert.match(extension, /sendDiagnosisToAgentChat\(vscode, prompt\)/);
  assert.match(extension, /buildDiagnosisHandoffPrompt\(/);
  assert.doesNotMatch(extension, /askProjectAgent[\s\S]{0,800}(?:fetch\(|openExternal\(|spawn\()/);
  assert.match(router, /askAgent: \(message\) => host\.askProjectAgent\(message\.id\)/);
  assert.match(
    webview,
    /'ask-agent': \(\) => \{[\s\S]*closeMenus\(\);[\s\S]*type: 'askAgent', id: button\.dataset\.id/
  );
  assert.match(
    webview,
    /diagnosis\.agentReady \? `[\s\S]*data-action="ask-agent"[\s\S]*Ask your agent/
  );
  assert.match(webview, /diagnosis\.handoffNotice \? escapeHtml\(diagnosis\.handoffNotice\)/);
  assert.match(extension, /Sent \$\{project\.name\} failure details to your agent/);
});
