/**
 * Start a project in a VS Code terminal tab titled exactly the project name.
 * Stop ends the process but keeps the tab. Closing the tab ends the process.
 */

function createProjectTerminalLauncher(vscode, options = {}) {
  const terminals = new Map();
  const byTerminal = new Map();
  const handles = new Map();
  const onClosed = typeof options.onTerminalClosed === 'function'
    ? options.onTerminalClosed
    : async () => {};

  const closeSubscription = vscode.window.onDidCloseTerminal?.((terminal) => {
    const projectId = byTerminal.get(terminal);
    if (!projectId) {
      return;
    }
    byTerminal.delete(terminal);
    const handle = handles.get(projectId);
    if (handle) {
      handle._emitExit(null, 'terminal-closed');
      handles.delete(projectId);
    }
    if (terminals.get(projectId) === terminal) {
      terminals.delete(projectId);
    }
    void onClosed(projectId, terminal);
  });

  const endSubscription = vscode.window.onDidEndTerminalShellExecution?.((event) => {
    const projectId = byTerminal.get(event.terminal);
    if (!projectId) {
      return;
    }
    const handle = handles.get(projectId);
    if (!handle || handle.terminal !== event.terminal) {
      return;
    }
    const code = Number.isInteger(event.exitCode) ? event.exitCode : 0;
    handle._emitExit(code, null);
  });

  function get(projectId) {
    return terminals.get(projectId);
  }

  function getHandle(projectId) {
    return handles.get(projectId);
  }

  function remember(projectId, terminal) {
    const previous = terminals.get(projectId);
    if (previous && previous !== terminal) {
      byTerminal.delete(previous);
    }
    terminals.set(projectId, terminal);
    byTerminal.set(terminal, projectId);
  }

  async function start({
    projectId,
    name,
    folder,
    command,
    env
  }) {
    const title = String(name || '').trim() || 'project';
    let terminal = terminals.get(projectId);
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({
        name: title,
        cwd: folder,
        env: env && typeof env === 'object' ? env : undefined
      });
      remember(projectId, terminal);
    } else {
      remember(projectId, terminal);
    }
    terminal.show(true);
    const line = String(command || '').trim();
    if (!line) {
      throw new Error('Start command is empty.');
    }
    // Interrupt any prior command in the reused Restart tab, then launch.
    try {
      terminal.sendText('\u0003', false);
    } catch {
      // First start has nothing to interrupt.
    }
    terminal.sendText(line, true);
    let pid;
    try {
      pid = await terminal.processId;
    } catch {
      pid = undefined;
    }
    const handle = createTerminalProcessHandle(terminal, pid);
    handles.set(projectId, handle);
    return { terminal, pid, handle };
  }

  function interrupt(projectId) {
    const terminal = terminals.get(projectId);
    if (!terminal) {
      return false;
    }
    try {
      terminal.sendText('\u0003', false);
      return true;
    } catch {
      return false;
    }
  }

  function dispose(projectId) {
    const terminal = terminals.get(projectId);
    handles.delete(projectId);
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
    endSubscription?.dispose?.();
  }

  return {
    dispose,
    disposeAll,
    get,
    getHandle,
    interrupt,
    start
  };
}

function createTerminalProcessHandle(terminal, pid) {
  const listeners = {
    exit: [],
    error: []
  };
  let exited = false;
  return {
    pid,
    terminal,
    killed: false,
    stdout: { on() {}, once() {} },
    stderr: { on() {}, once() {} },
    once(event, callback) {
      if (!listeners[event] || typeof callback !== 'function') {
        return;
      }
      listeners[event].push(callback);
    },
    on(event, callback) {
      this.once(event, callback);
    },
    kill() {
      this.killed = true;
      try {
        terminal.sendText('\u0003', false);
      } catch {
        // Terminal may already be closed.
      }
    },
    _emitExit(code, signal) {
      if (exited) {
        return;
      }
      exited = true;
      for (const callback of listeners.exit) {
        try {
          callback(code, signal);
        } catch {
          // Listener errors must not break lifecycle cleanup.
        }
      }
    }
  };
}

module.exports = {
  createProjectTerminalLauncher,
  createTerminalProcessHandle
};
