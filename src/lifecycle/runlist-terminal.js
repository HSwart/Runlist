function runlistTerminalName(projectName) {
  const name = String(projectName || 'project').trim();
  return `Runlist · ${name || 'project'}`;
}

function formatTerminalWrite(chunk) {
  return String(chunk).replace(/\r?\n/g, '\r\n');
}

class RunlistTerminalSession {
  constructor(vscode, options = {}) {
    const { name, cwd, env, onClose } = options;
    this.onClose = onClose;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    const pty = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {},
      close: () => {
        this.disposed = true;
        this.closeEmitter.fire(0);
        if (typeof this.onClose === 'function') {
          this.onClose();
        }
      },
      handleInput: () => {}
    };
    this.terminal = vscode.window.createTerminal({
      name,
      cwd,
      env,
      pty
    });
    this.disposed = false;
  }

  write(chunk) {
    if (this.disposed || chunk === undefined || chunk === null) {
      return;
    }
    const text = formatTerminalWrite(chunk);
    if (!text) {
      return;
    }
    this.writeEmitter.fire(text);
  }

  show(preserveFocus = false) {
    if (!this.disposed) {
      this.terminal.show(preserveFocus);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.terminal.dispose();
    } catch {
      // The terminal tab may already be gone.
    }
  }
}

function createRunlistTerminalSession(vscode, options) {
  return new RunlistTerminalSession(vscode, options);
}

module.exports = {
  RunlistTerminalSession,
  createRunlistTerminalSession,
  formatTerminalWrite,
  runlistTerminalName
};
