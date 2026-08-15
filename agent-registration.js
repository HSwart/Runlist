const path = require('path');
const { spawn } = require('child_process');

const SERVER_NAME = 'switchboard';
const MACOS_CODEX_CLI = '/Applications/Codex.app/Contents/Resources/codex';

function codexCommandCandidates(platform = process.platform) {
  return platform === 'darwin'
    ? ['codex', MACOS_CODEX_CLI]
    : ['codex'];
}

function claudeCommandCandidates(
  platform = process.platform,
  environment = process.env
) {
  const candidates = ['claude'];
  const userDirectory = environment.USERPROFILE || environment.HOME;
  if (userDirectory) {
    candidates.push(path.join(
      userDirectory,
      '.local',
      'bin',
      platform === 'win32' ? 'claude.exe' : 'claude'
    ));
  }
  return [...new Set(candidates)];
}

function serverEnvironmentArguments(projectsFile) {
  return [
    '--env',
    `SWITCHBOARD_PROJECTS_FILE=${projectsFile}`,
    '--env',
    'ELECTRON_RUN_AS_NODE=1'
  ];
}

function buildCodexAddArguments({ projectsFile, runtimePath, serverPath }) {
  return [
    'mcp',
    'add',
    SERVER_NAME,
    ...serverEnvironmentArguments(projectsFile),
    '--',
    runtimePath,
    serverPath
  ];
}

function buildClaudeAddArguments({ projectsFile, runtimePath, serverPath }) {
  return [
    'mcp',
    'add',
    '--transport',
    'stdio',
    ...serverEnvironmentArguments(projectsFile),
    '--scope',
    'user',
    SERVER_NAME,
    '--',
    runtimePath,
    serverPath
  ];
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
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
  candidates,
  clientLabel,
  removeArguments
}, run = runProcess) {
  const command = await findCommand(candidates, clientLabel, run);

  try {
    await run(command, removeArguments);
  } catch (error) {
    if (!isMissingServerError(error)) {
      throw error;
    }
  }

  await run(command, addArguments);
}

async function registerWithCodex(options, run = runProcess) {
  return refreshRegistration({
    addArguments: buildCodexAddArguments(options),
    candidates: codexCommandCandidates(options.platform),
    clientLabel: 'Codex',
    removeArguments: ['mcp', 'remove', SERVER_NAME]
  }, run);
}

async function registerWithClaude(options, run = runProcess) {
  return refreshRegistration({
    addArguments: buildClaudeAddArguments(options),
    candidates: claudeCommandCandidates(options.platform, options.environment),
    clientLabel: 'Claude Code',
    removeArguments: ['mcp', 'remove', '--scope', 'user', SERVER_NAME]
  }, run);
}

module.exports = {
  buildClaudeAddArguments,
  buildCodexAddArguments,
  claudeCommandCandidates,
  codexCommandCandidates,
  findCommand,
  registerWithClaude,
  registerWithCodex,
  runProcess
};
