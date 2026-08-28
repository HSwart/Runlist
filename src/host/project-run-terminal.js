function runlistTerminalName(projectName) {
  const name = String(projectName || '').trim() || 'project';
  return `Runlist · ${name}`;
}

function normalizePtyText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function createWriteEmitter(vscode) {
  if (typeof vscode?.EventEmitter === 'function') {
    return new vscode.EventEmitter();
  }
  const listeners = [];
  const event = (listener) => {
    if (typeof listener === 'function') {
      listeners.push(listener);
    }
    return { dispose() {} };
  };
  return {
    event,
    fire(value) {
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
    dispose() {
      listeners.length = 0;
    }
  };
}

function createProjectRunTerminalSession(vscode, options = {}) {
  const name = runlistTerminalName(options.name);
  const writeEmitter = createWriteEmitter(vscode);
  let closed = false;
  const notifyClosed = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      writeEmitter.dispose?.();
    } catch {
      // Emitter cleanup is best-effort after the tab is gone.
    }
    if (typeof options.onClose === 'function') {
      options.onClose();
    }
  };
  const pty = {
    onDidWrite: writeEmitter.event,
    open() {},
    close() {
      notifyClosed();
    }
  };
  const terminal = vscode.window.createTerminal({
    name,
    cwd: options.cwd,
    pty
  });
  return {
    name,
    cwd: options.cwd,
    terminal,
    get closed() {
      return closed;
    },
    write(text) {
      if (closed) {
        return false;
      }
      writeEmitter.fire(normalizePtyText(text));
      return true;
    },
    show(preserveFocus = true) {
      if (closed) {
        return false;
      }
      terminal.show(preserveFocus);
      return true;
    },
    matches(candidate) {
      return candidate === terminal;
    },
    dispose() {
      if (closed) {
        return;
      }
      try {
        terminal.dispose();
      } catch {
        notifyClosed();
      }
    },
    markClosed: notifyClosed
  };
}

class ProjectRunTerminalRegistry {
  constructor() {
    this.sessions = new Map();
  }

  get(projectId) {
    const session = this.sessions.get(projectId);
    if (!session || session.closed) {
      this.sessions.delete(projectId);
      return undefined;
    }
    return session;
  }

  has(projectId) {
    return Boolean(this.get(projectId));
  }

  attach(vscode, projectId, options = {}) {
    const existing = this.get(projectId);
    if (existing) {
      return existing;
    }
    const session = createProjectRunTerminalSession(vscode, {
      ...options,
      onClose: () => {
        if (this.sessions.get(projectId) === session) {
          this.sessions.delete(projectId);
        }
        if (typeof options.onClose === 'function') {
          options.onClose();
        }
      }
    });
    this.sessions.set(projectId, session);
    return session;
  }

  write(projectId, text) {
    return this.get(projectId)?.write(text) === true;
  }

  show(projectId, preserveFocus = false) {
    return this.get(projectId)?.show(preserveFocus) === true;
  }

  handleDidCloseTerminal(terminal) {
    for (const [projectId, session] of this.sessions) {
      if (session.matches(terminal)) {
        session.markClosed();
        this.sessions.delete(projectId);
      }
    }
  }

  dispose(projectId) {
    const session = this.sessions.get(projectId);
    this.sessions.delete(projectId);
    session?.dispose();
  }

  disposeAll() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.dispose();
    }
  }
}

function writeRunCommandHeader(session, command) {
  if (!session) {
    return false;
  }
  const display = String(command || '').trim();
  return session.write(display ? `\r\n$ ${display}\r\n` : '\r\n');
}

module.exports = {
  ProjectRunTerminalRegistry,
  createProjectRunTerminalSession,
  normalizePtyText,
  runlistTerminalName,
  writeRunCommandHeader
};
