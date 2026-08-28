const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertProject } = require('../src/projects/project-store');
const { readShippedHostSource } = require('./helpers/extension-source');

function mockVscode(messages) {
  const terminals = [];
  class EventEmitter {
    constructor() {
      this.listeners = [];
    }

    get event() {
      return (listener) => {
        this.listeners.push(listener);
        return { dispose() {} };
      };
    }

    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose() {
      this.listeners.length = 0;
    }
  }
  return {
    terminals,
    env: { remoteName: undefined },
    extensions: { getExtension: () => undefined },
    EventEmitter,
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      createTerminal: (options) => {
        const calls = { options, showCalls: [], written: [], disposed: false };
        options.pty?.onDidWrite?.((chunk) => {
          calls.written.push(chunk);
        });
        const terminal = {
          show: (preserveFocus) => {
            calls.showCalls.push(preserveFocus);
          },
          dispose: () => {
            calls.disposed = true;
            options.pty?.close?.();
          }
        };
        calls.terminal = terminal;
        terminals.push(calls);
        return terminal;
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      showErrorMessage(message) {
        messages.push({ type: 'error', message });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message) {
        messages.push({ type: 'warning', message });
        return Promise.resolve(undefined);
      },
      showInformationMessage(message) {
        messages.push({ type: 'info', message });
        return Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
}

function loadRunlistProvider(messages) {
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = mockVscode(messages);
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

test('Start keeps piped stdio ownership and mirrors output into a named terminal', () => {
  const host = readShippedHostSource();
  assert.match(host, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(host, /this\.processes\.set\(id, child\);\s*this\.ensureProjectRunTerminal\(id, launchProject, launchCommand\)/);
  assert.match(host, /listenToProjectOutput\(child, \(chunk\) => this\.addProjectOutput\(id, chunk, savedProjectRevision\)\)/);
  assert.match(host, /this\.writeProjectRunTerminal\(id, chunk\)/);
  assert.match(host, /this\.projectRunTerminals\.show\(id, false\)/);
  assert.doesNotMatch(host, /sendText\(/);
});

test('creates and reuses a named run terminal, then Show terminal focuses it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-run-terminal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'Cafe App',
    folder,
    startCommand: 'npm run dev',
    services: []
  }, { reviewRequired: false }).project;
  const messages = [];
  const { Provider, vscode } = loadRunlistProvider(messages);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.projects = [project];

  provider.ensureProjectRunTerminal(project.id, project, 'npm run dev');
  provider.addProjectOutput(project.id, 'server ready\n');
  provider.ensureProjectRunTerminal(project.id, project, 'npm run dev');

  assert.equal(vscode.terminals.length, 1);
  assert.equal(vscode.terminals[0].options.name, 'Runlist · Cafe App');
  assert.equal(vscode.terminals[0].options.cwd, folder);
  assert.ok(vscode.terminals[0].options.pty);
  assert.deepEqual(vscode.terminals[0].written, [
    '\r\n$ npm run dev\r\n',
    'server ready\r\n',
    '\r\n$ npm run dev\r\n'
  ]);
  assert.ok(vscode.terminals[0].showCalls.includes(true));

  await provider.showProjectRunTerminal(project.id);
  assert.ok(vscode.terminals[0].showCalls.includes(false));
  assert.equal(typeof vscode.terminals[0].terminal.sendText, 'undefined');
});

test('Show terminal falls back to a blank folder terminal when no run is attached', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-run-terminal-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsFile = path.join(root, 'projects.json');
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const project = upsertProject(projectsFile, {
    name: 'Cafe App',
    folder,
    startCommand: 'npm run dev',
    services: []
  }, { reviewRequired: false }).project;
  const messages = [];
  const { Provider, vscode } = loadRunlistProvider(messages);
  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  provider.projects = [project];

  await provider.showProjectRunTerminal(project.id);

  assert.equal(vscode.terminals.length, 1);
  assert.deepEqual(vscode.terminals[0].options, { cwd: folder });
  assert.equal(vscode.terminals[0].options.pty, undefined);
  assert.match(messages.find((item) => item.type === 'info')?.message || '', /No start output is attached/);
});
