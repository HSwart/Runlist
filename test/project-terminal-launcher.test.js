const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProjectTerminalLauncher,
  createTerminalProcessHandle
} = require('../src/lifecycle/project-terminal-launcher');

test('terminal process handle interrupt keeps the tab semantics', () => {
  const sent = [];
  const terminal = {
    sendText(text) {
      sent.push(text);
    }
  };
  const handle = createTerminalProcessHandle(terminal, 99);
  let exited = false;
  handle.once('exit', () => {
    exited = true;
  });
  handle.kill();
  assert.deepEqual(sent, ['\u0003']);
  handle._emitExit(0, null);
  assert.equal(exited, true);
});

test('launcher reuses a named terminal and titles it with the project name', async () => {
  const created = [];
  const fakeTerminal = {
    name: '',
    exitStatus: undefined,
    processId: Promise.resolve(123),
    sendText() {},
    show() {},
    dispose() {}
  };
  const vscode = {
    window: {
      createTerminal(options) {
        created.push(options);
        fakeTerminal.name = options.name;
        return fakeTerminal;
      },
      onDidCloseTerminal() {
        return { dispose() {} };
      },
      onDidEndTerminalShellExecution() {
        return { dispose() {} };
      }
    }
  };
  const launcher = createProjectTerminalLauncher(vscode);
  const first = await launcher.start({
    projectId: 'p1',
    name: 'My App',
    folder: '/tmp/app',
    command: 'npm start',
    env: { PORT: '3000' }
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'My App');
  assert.equal(created[0].cwd, '/tmp/app');
  assert.equal(first.pid, 123);
  const second = await launcher.start({
    projectId: 'p1',
    name: 'My App',
    folder: '/tmp/app',
    command: 'npm start'
  });
  assert.equal(created.length, 1);
  assert.equal(second.terminal, fakeTerminal);
  launcher.disposeAll();
});
