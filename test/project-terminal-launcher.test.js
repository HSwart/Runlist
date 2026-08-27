const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createProjectTerminalLauncher } = require('../src/lifecycle/project-terminal-launcher');

test('launcher creates a named PTY terminal and reuses it on restart', () => {
  const created = [];
  const FakeEmitter = class {
    constructor() {
      this.emitter = new EventEmitter();
    }
    get event() {
      return (listener) => {
        this.emitter.on('event', listener);
        return { dispose() {} };
      };
    }
    fire(value) {
      this.emitter.emit('event', value);
    }
  };
  const fakeTerminal = {
    exitStatus: undefined,
    show() {},
    dispose() {},
    __runlistRebind: undefined
  };
  const vscodeApi = {
    EventEmitter: FakeEmitter,
    window: {
      createTerminal(options) {
        created.push(options);
        assert.equal(options.name, 'My App');
        assert.ok(options.pty);
        return fakeTerminal;
      },
      onDidCloseTerminal() {
        return { dispose() {} };
      }
    }
  };
  const launcher = createProjectTerminalLauncher(vscodeApi);
  const child = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write() {} },
    killed: false
  };
  const first = launcher.attach('p1', { name: 'My App', child });
  assert.equal(created.length, 1);
  assert.equal(first, fakeTerminal);
  const nextChild = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write() {} },
    killed: false
  };
  const second = launcher.attach('p1', { name: 'My App', child: nextChild });
  assert.equal(created.length, 1);
  assert.equal(second, fakeTerminal);
  launcher.disposeAll();
});
