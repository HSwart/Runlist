function runlistTerminalName(projectName) {
  const name = String(projectName || 'project').trim();
  return `Runlist · ${name || 'project'}`;
}

class RunlistTerminalSession {
  constructor(vscode, options = {}) {
    const { name, cwd, env } = options;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    const pty = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {},
      close: () => {
        this.closeEmitter.fire(0);
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
    const text = String(chunk);
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
  runlistTerminalName
};
