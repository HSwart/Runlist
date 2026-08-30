const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RunlistTerminalSession,
  createRunlistTerminalSession,
  runlistTerminalName
} = require('../src/lifecycle/runlist-terminal');

test('runlistTerminalName prefixes the project name', () => {
  assert.equal(runlistTerminalName('My App'), 'Runlist · My App');
  assert.equal(runlistTerminalName(''), 'Runlist · project');
});

test('createRunlistTerminalSession mirrors output through a pseudoterminal', () => {
  const writes = [];
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
    window: {
      createTerminal: (options) => {
        assert.equal(options.name, 'Runlist · Demo');
        assert.equal(options.cwd, '/tmp/demo');
        assert.deepEqual(options.env, { PORT: '3000' });
        assert.equal(typeof options.pty.onDidWrite, 'function');
        options.pty.onDidWrite((chunk) => writes.push(chunk));
        return {
          show: () => {},
          dispose: () => {}
        };
      }
    }
  };

  const session = createRunlistTerminalSession(vscode, {
    name: runlistTerminalName('Demo'),
    cwd: '/tmp/demo',
    env: { PORT: '3000' }
  });
  session.write('hello\n');
  session.write('world');

  assert.deepEqual(writes, ['hello\n', 'world']);
});

test('RunlistTerminalSession show and dispose are idempotent', () => {
  let showCount = 0;
  let disposeCount = 0;
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
      fire() {}
    },
    window: {
      createTerminal: () => ({
        show: () => {
          showCount += 1;
        },
        dispose: () => {
          disposeCount += 1;
        }
      })
    }
  };

  const session = new RunlistTerminalSession(vscode, { name: 'Runlist · App', cwd: '/tmp' });
  session.show();
  session.show();
  session.dispose();
  session.dispose();
  session.write('ignored');

  assert.equal(showCount, 2);
  assert.equal(disposeCount, 1);
});
