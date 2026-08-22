const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const SERVER_NAME = 'runlist';
const MACOS_CODEX_CLI = '/Applications/Codex.app/Contents/Resources/codex';
const WINDOWS_SHELL_EXTENSIONS = /\.(?:bat|cmd)$/i;
const WINDOWS_SHELL_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function codexBundledCliPath(extensionPath, platform = process.platform, arch = process.arch) {
  if (!extensionPath) {
    return undefined;
  }

  const platformDirectory = {
    darwin: 'macos',
    linux: 'linux',
    win32: 'windows'
  }[platform];
  const architecture = {
    arm64: 'aarch64',
    x64: 'x86_64'
  }[arch];
  if (!platformDirectory || !architecture) {
    return undefined;
  }

  const pathForPlatform = platform === 'win32' ? path.win32 : path.posix;
  return pathForPlatform.join(
    extensionPath,
    'bin',
    `${platformDirectory}-${architecture}`,
    platform === 'win32' ? 'codex.exe' : 'codex'
  );
}

function claudeBundledCliPaths(extensionPath, platform = process.platform, arch = process.arch) {
  if (!extensionPath) {
    return [];
  }

  const pathForPlatform = platform === 'win32' ? path.win32 : path.posix;
  const executable = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [pathForPlatform.join(
    extensionPath,
    'resources',
    'native-binaries',
    `${platform}-${arch}`,
    executable
  )];
  if (platform === 'win32' && arch === 'arm64') {
    candidates.push(path.win32.join(
      extensionPath,
      'resources',
      'native-binaries',
      'win32-x64',
      executable
    ));
  }
  candidates.push(pathForPlatform.join(
    extensionPath,
    'resources',
    'native-binary',
    executable
  ));
  return uniqueCandidates(candidates);
}

function codexCommandCandidates(
  platform = process.platform,
  environment = process.env,
  bundledCliPath
) {
  if (platform === 'darwin') {
    return uniqueCandidates(['codex', bundledCliPath, MACOS_CODEX_CLI]);
  }
  if (platform !== 'win32') {
    return uniqueCandidates(['codex', bundledCliPath]);
  }

  const npmShim = environment.APPDATA
    ? path.win32.join(environment.APPDATA, 'npm', 'codex.cmd')
    : undefined;
  return uniqueCandidates(['codex.exe', bundledCliPath, npmShim, 'codex.cmd']);
}

function claudeCommandCandidates(
  platform = process.platform,
  environment = process.env,
  bundledCliPaths = []
) {
  const userDirectory = environment.USERPROFILE || environment.HOME;
  if (platform === 'win32') {
    const nativeCli = userDirectory
      ? path.win32.join(userDirectory, '.local', 'bin', 'claude.exe')
      : undefined;
    const npmShim = environment.APPDATA
      ? path.win32.join(environment.APPDATA, 'npm', 'claude.cmd')
      : undefined;
    return uniqueCandidates([
      'claude.exe',
      nativeCli,
      ...bundledCliPaths,
      npmShim,
      'claude.cmd'
    ]);
  }

  const nativeCli = userDirectory
    ? path.posix.join(userDirectory, '.local', 'bin', 'claude')
    : undefined;
  return uniqueCandidates(['claude', nativeCli]);
}

function uniqueCandidates(candidates) {
  return [...new Set(candidates.filter(Boolean))];
}

function serverEnvironmentArguments(projectsFile) {
  return [
    '--env',
    `RUNLIST_PROJECTS_FILE=${projectsFile}`,
    '--env',
    'ELECTRON_RUN_AS_NODE=1'
  ];
}

function buildCodexAddArguments({ projectsFile, runtimePath, serverPath }, serverName = SERVER_NAME) {
  return [
    'mcp',
    'add',
    serverName,
    ...serverEnvironmentArguments(projectsFile),
    '--',
    runtimePath,
    serverPath
  ];
}

function buildClaudeAddArguments({ projectsFile, runtimePath, serverPath }, serverName = SERVER_NAME) {
  return [
    'mcp',
    'add',
    '--transport',
    'stdio',
    ...serverEnvironmentArguments(projectsFile),
    '--scope',
    'user',
    serverName,
    '--',
    runtimePath,
    serverPath
  ];
}

function escapeWindowsCommand(value) {
  return String(value).replace(WINDOWS_SHELL_META_CHARACTERS, '^$1');
}

function escapeWindowsArgument(value, doubleEscapeMetaCharacters = false) {
  let argument = String(value);
  argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  argument = argument.replace(/(?=(\\+?)?)\1$/, '$1$1');
  argument = `"${argument}"`.replace(WINDOWS_SHELL_META_CHARACTERS, '^$1');
  return doubleEscapeMetaCharacters
    ? argument.replace(WINDOWS_SHELL_META_CHARACTERS, '^$1')
    : argument;
}

function processInvocation(
  command,
  args,
  platform = process.platform,
  environment = process.env
) {
  if (platform !== 'win32' || !WINDOWS_SHELL_EXTENSIONS.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }

  const doubleEscape = /node_modules[\\/]+\.bin[\\/]+[^\\/]+\.cmd$/i.test(command);
  const commandLine = [
    escapeWindowsCommand(path.win32.normalize(command)),
    ...args.map((argument) => escapeWindowsArgument(argument, doubleEscape))
  ].join(' ');
  return {
    command: environment.ComSpec || environment.COMSPEC || environment.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

function runProcess(command, args, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const invocation = processInvocation(command, args, platform, environment);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: environment,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => reject(error));
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const detail = (stderr || stdout).trim();
      const error = new Error(detail || `${command} exited with code ${code}.`);
      error.exitCode = code;
      if (platform === 'win32'
        && WINDOWS_SHELL_EXTENSIONS.test(command)
        && /is not recognized as an internal or external command/i.test(detail)) {
        error.code = 'ENOENT';
      }
      reject(error);
    });
  });
}

async function findCommand(candidates, clientLabel, run = runProcess) {
  let missingError;
  for (const candidate of candidates) {
    try {
      await run(candidate, ['--version']);
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      missingError = error;
    }
  }

  const error = new Error(`${clientLabel} CLI was not found.`);
  error.code = missingError?.code || 'ENOENT';
  throw error;
}

function isMissingServerError(error) {
  return /No MCP server named|MCP server .* (?:not found|does not exist)/i.test(error.message);
}

async function refreshRegistration({
  addArguments,
  candidateAddArguments,
  candidateRemoveArguments,
  candidates,
  clientLabel,
  environment,
  getArguments,
  platform,
  removeArguments
}, run = runProcess) {
  const execute = (command, args) => run(command, args, { environment, platform });
  const command = await findCommand(candidates, clientLabel, execute);

  let registrationExists = true;
  try {
    await execute(command, getArguments);
  } catch (error) {
    if (!isMissingServerError(error)) {
      throw error;
    }
    registrationExists = false;
  }

  if (!registrationExists) {
    await execute(command, addArguments);
    return;
  }

  await execute(command, candidateAddArguments);
  try {
    await execute(command, removeArguments);
  } catch (error) {
    if (!isMissingServerError(error)) {
      throw error;
    }
  }
  try {
    await execute(command, addArguments);
  } catch (error) {
    error.fallbackRegistration = candidateAddArguments;
    throw error;
  }

  try {
    await execute(command, candidateRemoveArguments);
  } catch {
    // The requested registration is active; a temporary preflight entry is harmless.
  }
}

async function registerWithCodex(options, run = runProcess) {
  const candidateName = options.candidateName || `${SERVER_NAME}-refresh-${crypto.randomUUID()}`;
  return refreshRegistration({
    addArguments: buildCodexAddArguments(options),
    candidateAddArguments: buildCodexAddArguments(options, candidateName),
    candidateRemoveArguments: ['mcp', 'remove', candidateName],
    candidates: codexCommandCandidates(
      options.platform,
      options.environment,
      options.bundledCliPath
    ),
    clientLabel: 'Codex',
    environment: options.environment,
    getArguments: ['mcp', 'get', SERVER_NAME, '--json'],
    platform: options.platform,
    removeArguments: ['mcp', 'remove', SERVER_NAME]
  }, run);
}

async function registerWithClaude(options, run = runProcess) {
  const candidateName = options.candidateName || `${SERVER_NAME}-refresh-${crypto.randomUUID()}`;
  return refreshRegistration({
    addArguments: buildClaudeAddArguments(options),
    candidateAddArguments: buildClaudeAddArguments(options, candidateName),
    candidateRemoveArguments: ['mcp', 'remove', '--scope', 'user', candidateName],
    candidates: claudeCommandCandidates(
      options.platform,
      options.environment,
      options.bundledCliPaths
    ),
    clientLabel: 'Claude Code',
    environment: options.environment,
    getArguments: ['mcp', 'get', SERVER_NAME],
    platform: options.platform,
    removeArguments: ['mcp', 'remove', '--scope', 'user', SERVER_NAME]
  }, run);
}

module.exports = {
  buildClaudeAddArguments,
  buildCodexAddArguments,
  claudeBundledCliPaths,
  claudeCommandCandidates,
  codexBundledCliPath,
  codexCommandCandidates,
  findCommand,
  processInvocation,
  registerWithClaude,
  registerWithCodex,
  runProcess
};
