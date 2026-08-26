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

function splitCommandTokens(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (character === '\\' && quote === '"' && command[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function composeCommandToDockerArgs(command) {
  const tokens = splitCommandTokens(String(command || '').trim());
  if (tokens.length < 4 || tokens[0] !== 'docker' || tokens[1] !== 'compose') {
    throw new Error(`Unsupported compose command: ${command}`);
  }
  return tokens.slice(1);
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
      await execFileAsync('sudo', ['docker', 'info'], baseOptions);
      cachedDockerShellMode = 'sudo';
      return (args, options = {}) => execFileAsync('sudo', ['docker', ...args], {
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

async function resolveDockerSpawnSpec(dockerArgs) {
  await detectDockerInvoker();
  if (cachedDockerShellMode === 'sudo') {
    return { executable: 'sudo', argv: ['docker', ...dockerArgs] };
  }
  if (cachedDockerShellMode === 'sg') {
    throw new Error('Attached compose requires direct or sudo Docker access.');
  }
  return { executable: 'docker', argv: dockerArgs };
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

async function runComposeCommand(command, options = {}) {
  const dockerArgs = composeCommandToDockerArgs(command);
  await runDocker(dockerArgs, {
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000,
    cwd: options.cwd,
    env: options.env
  });
}

function spawnComposeProcess(command, options = {}) {
  const dockerArgs = composeCommandToDockerArgs(command);
  return resolveDockerSpawnSpec(dockerArgs).then(({ executable, argv }) => spawn(executable, argv, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  }));
}

async function runComposeUpAttached(startCommand, options = {}) {
  const child = await spawnComposeProcess(startCommand, {
    cwd: options.cwd,
    env: options.env
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
  composeCommandToDockerArgs,
  composeDown,
  createComposeWorkspace,
  createProbeExecFileAsync,
  dockerCommand,
  dockerRuntimeAvailable,
  reserveLocalPort,
  runComposeCommand,
  runComposeUpAttached,
  runDocker,
  sleep,
  splitCommandTokens,
  waitForTcpPort,
  waitForTcpPortClosed,
  withComposeProjectName,
  writeComposeFixture
};
