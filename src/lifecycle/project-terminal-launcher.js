/**
 * Start a project in a VS Code terminal tab titled exactly the project name.
 * Process control stays on the spawned child (ownership-safe). The terminal is a
 * real Extension PTY so stdin works and I/O is visible in the Terminal panel.
 */

function createProjectTerminalLauncher(vscodeApi, options = {}) {
  if (!vscodeApi?.window?.createTerminal) {
    return {
      attach() {
        return undefined;
      },
      dispose() {},
      disposeAll() {},
      get() {
        return undefined;
      }
    };
  }
  const terminals = new Map();
  const byTerminal = new Map();
  const onClosed = typeof options.onTerminalClosed === 'function'
    ? options.onTerminalClosed
    : async () => {};

  const closeSubscription = vscodeApi.window.onDidCloseTerminal?.((terminal) => {
    const projectId = byTerminal.get(terminal);
    if (!projectId) {
      return;
    }
    byTerminal.delete(terminal);
    if (terminals.get(projectId) === terminal) {
      terminals.delete(projectId);
    }
    void onClosed(projectId, terminal);
  });

  function get(projectId) {
    return terminals.get(projectId);
  }

  function remember(projectId, terminal) {
    const previous = terminals.get(projectId);
    if (previous && previous !== terminal) {
      byTerminal.delete(previous);
    }
    terminals.set(projectId, terminal);
    byTerminal.set(terminal, projectId);
  }

  function attach(projectId, { name, child }) {
    if (!vscodeApi.EventEmitter) {
      return undefined;
    }
    const title = String(name || '').trim() || 'project';
    let terminal = terminals.get(projectId);
    if (terminal && terminal.exitStatus === undefined) {
      // Restart reuses the same tab; rebind writers to the new child.
      if (typeof terminal.__runlistRebind === 'function') {
        terminal.__runlistRebind(child);
      }
      terminal.show(true);
      remember(projectId, terminal);
      return terminal;
    }

    const writeEmitter = new vscodeApi.EventEmitter();
    const closeEmitter = new vscodeApi.EventEmitter();
    let activeChild = child;
    let closed = false;

    function pipeChild(nextChild) {
      activeChild = nextChild;
      if (!nextChild) {
        return;
      }
      nextChild.stdout?.on?.('data', (chunk) => {
        writeEmitter.fire(String(chunk));
      });
      nextChild.stderr?.on?.('data', (chunk) => {
        writeEmitter.fire(String(chunk));
      });
    }

    pipeChild(child);

    const pty = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open() {},
      close() {
        closed = true;
      },
      handleInput(data) {
        if (!activeChild || activeChild.killed || !activeChild.stdin) {
          return;
        }
        try {
          if (data === '\r') {
            activeChild.stdin.write('\n');
          } else {
            activeChild.stdin.write(data);
          }
        } catch {
          // Ignore stdin races after stop.
        }
      }
    };

    terminal = vscodeApi.window.createTerminal({
      name: title,
      pty
    });
    terminal.__runlistRebind = (nextChild) => {
      pipeChild(nextChild);
    };
    terminal.__runlistClose = () => {
      if (!closed) {
        closeEmitter.fire();
      }
    };
    remember(projectId, terminal);
    terminal.show(true);
    return terminal;
  }

  function dispose(projectId) {
    const terminal = terminals.get(projectId);
    if (!terminal) {
      return;
    }
    terminals.delete(projectId);
    byTerminal.delete(terminal);
    try {
      terminal.dispose();
    } catch {
      // Ignore dispose races.
    }
  }

  function disposeAll() {
    for (const id of [...terminals.keys()]) {
      dispose(id);
    }
    closeSubscription?.dispose?.();
  }

  return {
    attach,
    dispose,
    disposeAll,
    get
  };
}

module.exports = {
  createProjectTerminalLauncher
};
