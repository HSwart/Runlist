const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ProjectRunTerminalRegistry,
  createProjectRunTerminalSession,
  normalizePtyText,
  runlistTerminalName,
  writeRunCommandHeader
} = require('../src/host/project-run-terminal');

function mockVscode(options = {}) {
  const terminals = [];
  const closeListeners = [];
  return {
    terminals,
    EventEmitter: class {
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
    },
    window: {
      createTerminal: (createOptions) => {
        const calls = {
          options: createOptions,
          showCalls: [],
          disposed: false,
          written: []
        };
        createOptions.pty?.onDidWrite?.((chunk) => {
          calls.written.push(chunk);
        });
        const terminal = {
          show: (preserveFocus) => {
            calls.showCalls.push(preserveFocus);
          },
          dispose: () => {
            calls.disposed = true;
            createOptions.pty?.close?.();
            for (const listener of closeListeners) {
              listener(terminal);
            }
          }
        };
        calls.terminal = terminal;
        terminals.push(calls);
        return terminal;
      },
      onDidCloseTerminal: (listener) => {
        closeListeners.push(listener);
        return { dispose() {} };
      }
    }
  };
}

test('names the run terminal after the project without extra punctuation', () => {
  assert.equal(runlistTerminalName('Cafe App'), 'Runlist · Cafe App');
  assert.equal(runlistTerminalName('  '), 'Runlist · project');
  assert.equal(runlistTerminalName(), 'Runlist · project');
});

test('normalizes newlines for VS Code pseudoterminals', () => {
  assert.equal(normalizePtyText('ready\nerror\n'), 'ready\r\nerror\r\n');
  assert.equal(normalizePtyText('ready\r\nerror\r\n'), 'ready\r\nerror\r\n');
});

test('creates a named terminal with cwd and writes the start command', () => {
  const vscode = mockVscode();
  const session = createProjectRunTerminalSession(vscode, {
    name: 'API',
    cwd: '/Users/example/app'
  });

  writeRunCommandHeader(session, 'npm run dev');
  session.write('server ready\n');
  session.show(true);

  assert.equal(vscode.terminals.length, 1);
  assert.equal(vscode.terminals[0].options.name, 'Runlist · API');
  assert.equal(vscode.terminals[0].options.cwd, '/Users/example/app');
  assert.ok(vscode.terminals[0].options.pty);
  assert.deepEqual(vscode.terminals[0].written, ['\r\n$ npm run dev\r\n', 'server ready\r\n']);
  assert.deepEqual(vscode.terminals[0].showCalls, [true]);
  assert.equal(typeof vscode.terminals[0].terminal.sendText, 'undefined');
});

test('reuses one terminal per project and recreates after the tab is closed', () => {
  const vscode = mockVscode();
  const registry = new ProjectRunTerminalRegistry();
  const first = registry.attach(vscode, 'project-1', {
    name: 'API',
    cwd: '/tmp/api'
  });
  const reused = registry.attach(vscode, 'project-1', {
    name: 'API',
    cwd: '/tmp/api'
  });

  assert.equal(first, reused);
  assert.equal(vscode.terminals.length, 1);
  assert.equal(registry.show('project-1', false), true);
  assert.deepEqual(vscode.terminals[0].showCalls, [false]);

  vscode.terminals[0].terminal.dispose();
  assert.equal(registry.has('project-1'), false);
  assert.equal(registry.show('project-1'), false);

  registry.attach(vscode, 'project-1', {
    name: 'API',
    cwd: '/tmp/api'
  });
  assert.equal(vscode.terminals.length, 2);
  assert.equal(registry.has('project-1'), true);
});

test('closing one project terminal does not drop another project’s tab', () => {
  const vscode = mockVscode();
  const registry = new ProjectRunTerminalRegistry();
  registry.attach(vscode, 'one', { name: 'One', cwd: '/tmp/one' });
  registry.attach(vscode, 'two', { name: 'Two', cwd: '/tmp/two' });

  vscode.terminals[0].terminal.dispose();

  assert.equal(registry.has('one'), false);
  assert.equal(registry.has('two'), true);
  assert.equal(registry.write('two', 'still here\n'), true);
  assert.deepEqual(vscode.terminals[1].written, ['still here\r\n']);
});

test('does not send commands into an Open terminal here shell', () => {
  const vscode = mockVscode();
  const registry = new ProjectRunTerminalRegistry();
  registry.attach(vscode, 'project-1', { name: 'API', cwd: '/tmp/api' });
  assert.equal(typeof vscode.terminals[0].options.pty.open, 'function');
  assert.equal(vscode.terminals[0].options.pty.handleInput, undefined);
});
