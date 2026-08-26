const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;

let cachedDockerInvoker;
/** @type {'direct' | 'sg' | 'sudo' | undefined} */
let cachedDockerShellMode;

function shellQuote(value) {
  const text = String(value);
  if (!/[^\w@%+=:,./-]/u.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function detectDockerInvoker() {
  if (cachedDockerInvoker) {
    return cachedDockerInvoker;
  }
  const baseOptions = { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  const candidates = [
    async () => {
      await execFileAsync('docker', ['info'], baseOptions);
      cachedDockerShellMode = 'direct';
      return (args, options = {}) => execFileAsync('docker', args, {
        ...baseOptions,
        timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
        cwd: options.cwd,
        env: options.env
      });
    },
    async () => {
      await execFileAsync('sg', ['docker', '-c', 'docker info'], baseOptions);
      cachedDockerShellMode = 'sg';
      return (args, options = {}) => execFileAsync(
        'sg',
        ['docker', '-c', `docker ${args.map(shellQuote).join(' ')}`],
        {
          ...baseOptions,
          timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
          cwd: options.cwd,
          env: options.env
        }
      );
    },
    async () => {
      await execFileAsync('sudo', ['docker', 'info'], baseOptions);
      cachedDockerShellMode = 'sudo';
      return (args, options = {}) => execFileAsync('sudo', ['docker', ...args], {
        ...baseOptions,
        timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
        cwd: options.cwd,
        env: options.env
      });
    }
  ];

  for (const candidate of candidates) {
    try {
      cachedDockerInvoker = await candidate();
      return cachedDockerInvoker;
    } catch {
      // Try the next Docker invocation strategy.
    }
  }
  cachedDockerInvoker = undefined;
  cachedDockerShellMode = undefined;
  return undefined;
}

async function wrapDockerShell(command) {
  await detectDockerInvoker();
  if (cachedDockerShellMode === 'sudo') {
    return `sudo ${command}`;
  }
  if (cachedDockerShellMode === 'sg') {
    return `sg docker -c ${shellQuote(command)}`;
  }
  return command;
}

function withComposeProjectName(command, projectName) {
  const name = String(projectName || '').trim();
  if (!name || !/^\s*docker\s+compose\b/i.test(command)) {
    return command;
  }
  if (/\s-p\s+\S+/i.test(command)) {
    return command;
  }
  return command.replace(/^\s*(docker\s+compose)\b/i, `$1 -p ${shellQuote(name)}`);
}

async function createProbeExecFileAsync() {
  const invoker = await detectDockerInvoker();
  if (!invoker) {
    return undefined;
  }
  return async (command, args, options = {}) => {
    const result = await invoker(args, {
      timeoutMs: options.timeout,
      cwd: options.cwd,
      env: options.env
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  };
}

function dockerCommand() {
  return process.env.RUNLIST_DOCKER_CMD || 'docker';
}

async function runDocker(args, options = {}) {
  const invoker = await detectDockerInvoker();
  if (!invoker) {
    throw new Error('Docker is not available for integration tests.');
  }
  const result = await invoker(args, options);
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

async function dockerRuntimeAvailable() {
  if (process.env.RUNLIST_SKIP_DOCKER_INTEGRATION === '1') {
    return false;
  }
  try {
    const invoker = await detectDockerInvoker();
    if (!invoker) {
      return false;
    }
    await runDocker(['info'], { timeoutMs: 15_000 });
    await runDocker(['compose', 'version'], { timeoutMs: 15_000 });
    await runDocker(['run', '--rm', 'hello-world'], { timeoutMs: 60_000 });
    return true;
  } catch {
    return false;
  }
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForTcpPort(port, options = {}) {
  const host = options.host || '127.0.0.1';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const finish = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1000);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
    if (open) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForTcpPortClosed(port, options = {}) {
  const host = options.host || '127.0.0.1';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const open = await waitForTcpPort(port, { host, timeoutMs: 500 });
    if (!open) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createComposeWorkspace(prefix = 'runlist-compose-lifecycle-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    composePath: path.join(root, 'compose.yaml'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function writeComposeFixture(workspace, servicesYaml, options = {}) {
  const composeFileName = options.fileName || 'compose.yaml';
  const composePath = path.join(workspace.root, composeFileName);
  const contents = `services:\n${servicesYaml}\n`;
  fs.writeFileSync(composePath, contents, 'utf8');
  workspace.composePath = composePath;
  return { composePath, contents };
}

async function composeDown(composePath, projectName) {
  const args = ['compose', '-f', composePath];
  if (projectName) {
    args.push('-p', projectName);
  }
  args.push('down', '-v', '--remove-orphans');
  try {
    await runDocker(args, { timeoutMs: 60_000, cwd: path.dirname(composePath) });
  } catch {
    // Best-effort cleanup between tests.
  }
}

async function runShellCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000;
  const wrapped = options.wrapDocker === false ? command : await wrapDockerShell(command);
  if (platform === 'win32') {
    await execFileAsync('cmd.exe', ['/d', '/s', '/c', wrapped], {
      cwd: options.cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    return;
  }
  await execFileAsync('sh', ['-lc', wrapped], {
    cwd: options.cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  });
}

function spawnShellCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const shellCommand = options.shellCommand || command;
  if (platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', shellCommand], {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  }
  return spawn(shellCommand, {
    cwd: options.cwd,
    env: options.env || process.env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
}

async function runComposeUpAttached(startCommand, options = {}) {
  const shellCommand = await wrapDockerShell(startCommand);
  const child = spawnShellCommand(startCommand, {
    cwd: options.cwd,
    platform: options.platform,
    shellCommand
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async waitForExit(timeoutMs = 30_000) {
      if (child.exitCode !== null) {
        return child.exitCode;
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`compose up did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {
            // Process already exited.
          }
        }
      }
      await sleep(500);
    }
  };
}

module.exports = {
  composeDown,
  createComposeWorkspace,
  createProbeExecFileAsync,
  dockerCommand,
  dockerRuntimeAvailable,
  reserveLocalPort,
  runComposeUpAttached,
  runDocker,
  runShellCommand,
  sleep,
  spawnShellCommand,
  waitForTcpPort,
  waitForTcpPortClosed,
  withComposeProjectName,
  wrapDockerShell,
  writeComposeFixture
};
