const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeAddArguments,
  buildCodexAddArguments,
  claudeBundledCliPaths,
  claudeCommandCandidates,
  codexBundledCliPath,
  codexCommandCandidates,
  processInvocation,
  registerWithClaude,
  registerWithCodex
} = require('../agent-registration');

const options = {
  platform: 'linux',
  projectsFile: '/data/projects.json',
  runtimePath: '/opt/code/code',
  serverPath: '/extensions/switchboard/mcp/server.js'
};

test('builds a shell-free Codex registration with the bundled runtime', () => {
  assert.deepEqual(buildCodexAddArguments(options), [
    'mcp',
    'add',
    'switchboard',
    '--env',
    'SWITCHBOARD_PROJECTS_FILE=/data/projects.json',
    '--env',
    'ELECTRON_RUN_AS_NODE=1',
    '--',
    '/opt/code/code',
    '/extensions/switchboard/mcp/server.js'
  ]);
});

test('builds a user-scoped Claude Code registration with correctly ordered options', () => {
  assert.deepEqual(buildClaudeAddArguments(options), [
    'mcp',
    'add',
    '--transport',
    'stdio',
    '--env',
    'SWITCHBOARD_PROJECTS_FILE=/data/projects.json',
    '--env',
    'ELECTRON_RUN_AS_NODE=1',
    '--scope',
    'user',
    'switchboard',
    '--',
    '/opt/code/code',
    '/extensions/switchboard/mcp/server.js'
  ]);
});

test('uses bundled Codex and native Claude CLI fallbacks on macOS', () => {
  assert.deepEqual(codexCommandCandidates('darwin'), [
    'codex',
    '/Applications/Codex.app/Contents/Resources/codex'
  ]);
  assert.deepEqual(claudeCommandCandidates('darwin', { HOME: '/Users/example' }), [
    'claude',
    '/Users/example/.local/bin/claude'
  ]);
});

test('builds the Claude fallback with Windows path separators', () => {
  assert.deepEqual(claudeCommandCandidates('win32', {
    APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\example'
  }), [
    'claude.exe',
    'C:\\Users\\example\\.local\\bin\\claude.exe',
    'C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd',
    'claude.cmd'
  ]);
});

test('finds the Claude Code CLI bundled with its Windows extension', () => {
  const extensionPath = 'C:\\Users\\example\\.vscode\\extensions\\anthropic.claude-code';
  const bundledPaths = claudeBundledCliPaths(extensionPath, 'win32', 'arm64');
  assert.deepEqual(bundledPaths, [
    `${extensionPath}\\resources\\native-binaries\\win32-arm64\\claude.exe`,
    `${extensionPath}\\resources\\native-binaries\\win32-x64\\claude.exe`,
    `${extensionPath}\\resources\\native-binary\\claude.exe`
  ]);
  assert.deepEqual(claudeCommandCandidates('win32', {}, bundledPaths), [
    'claude.exe',
    ...bundledPaths,
    'claude.cmd'
  ]);
});

test('finds Windows Codex executables from VS Code and npm', () => {
  assert.equal(
    codexBundledCliPath('C:\\Users\\example\\.vscode\\extensions\\openai.chatgpt', 'win32', 'x64'),
    'C:\\Users\\example\\.vscode\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe'
  );
  assert.deepEqual(codexCommandCandidates(
    'win32',
    { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' },
    'D:\\VS Code\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe'
  ), [
    'codex.exe',
    'D:\\VS Code\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe',
    'C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd',
    'codex.cmd'
  ]);
});

test('builds the platform-specific bundled Codex paths', () => {
  assert.equal(
    codexBundledCliPath('/Users/example/.vscode/extensions/openai.chatgpt', 'darwin', 'arm64'),
    '/Users/example/.vscode/extensions/openai.chatgpt/bin/macos-aarch64/codex'
  );
  assert.equal(codexBundledCliPath('/extension', 'linux', 'x64'),
    '/extension/bin/linux-x86_64/codex');
  assert.equal(codexBundledCliPath('/extension', 'freebsd', 'x64'), undefined);
});

test('runs Windows cmd shims through cmd.exe without changing native executables', () => {
  const environment = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const shim = processInvocation(
    'C:\\Users\\Example User\\AppData\\Roaming\\npm\\codex.cmd',
    ['mcp', 'add', '--', 'C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    'win32',
    environment
  );
  assert.equal(shim.command, environment.ComSpec);
  assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(shim.windowsVerbatimArguments, true);
  assert.match(shim.args[3], /codex\.cmd/);
  assert.match(shim.args[3], /Code\.exe/);

  assert.deepEqual(processInvocation(
    'C:\\Program Files\\Codex\\codex.exe',
    ['--version'],
    'win32',
    environment
  ), {
    command: 'C:\\Program Files\\Codex\\codex.exe',
    args: ['--version'],
    windowsVerbatimArguments: false
  });
});

test('uses the Codex executable bundled with the VS Code extension on Windows', async () => {
  const bundledCliPath = 'C:\\VS Code\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe';
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'codex.exe') {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: '', stderr: '' };
  };

  await registerWithCodex({
    ...options,
    bundledCliPath,
    environment: {},
    platform: 'win32'
  }, run);

  assert.deepEqual(calls.slice(0, 3), [
    ['codex.exe', ['--version']],
    [bundledCliPath, ['--version']],
    [bundledCliPath, ['mcp', 'remove', 'switchboard']]
  ]);
  assert.deepEqual(calls[3], [bundledCliPath, buildCodexAddArguments(options)]);
});

test('uses the Claude executable bundled with the VS Code extension on Windows', async () => {
  const bundledCliPath = 'C:\\VS Code\\extensions\\anthropic.claude-code\\resources\\native-binary\\claude.exe';
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command !== bundledCliPath) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: '', stderr: '' };
  };

  await registerWithClaude({
    ...options,
    bundledCliPaths: [bundledCliPath],
    environment: {},
    platform: 'win32'
  }, run);

  assert.deepEqual(calls.slice(0, 4), [
    ['claude.exe', ['--version']],
    [bundledCliPath, ['--version']],
    [bundledCliPath, ['mcp', 'remove', '--scope', 'user', 'switchboard']],
    [bundledCliPath, buildClaudeAddArguments(options)]
  ]);
});

test('refreshes Codex registration before adding the current extension path', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: '', stderr: '' };
  };

  await registerWithCodex(options, run);

  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['mcp', 'remove', 'switchboard']],
    ['codex', buildCodexAddArguments(options)]
  ]);
});

test('refreshes the user-scoped Claude Code registration', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: '', stderr: '' };
  };

  await registerWithClaude({ ...options, environment: {} }, run);

  assert.deepEqual(calls, [
    ['claude', ['--version']],
    ['claude', ['mcp', 'remove', '--scope', 'user', 'switchboard']],
    ['claude', buildClaudeAddArguments(options)]
  ]);
});

test('allows first-time registration when no prior server exists', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'mcp' && args[1] === 'remove') {
      throw new Error("Error: No MCP server named 'switchboard' found.");
    }
    return { stdout: '', stderr: '' };
  };

  await registerWithCodex(options, run);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2][1], buildCodexAddArguments(options));
});
