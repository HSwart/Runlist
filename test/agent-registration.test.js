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
} = require('../src/integrations/agent-registration');

const options = {
  platform: 'linux',
  projectsFile: '/data/projects.json',
  runtimePath: '/opt/code/code',
  serverPath: '/extensions/runlist/mcp/server.js'
};

test('builds a shell-free Codex registration with the bundled runtime', () => {
  assert.deepEqual(buildCodexAddArguments(options), [
    'mcp',
    'add',
    'runlist',
    '--env',
    'RUNLIST_PROJECTS_FILE=/data/projects.json',
    '--env',
    'ELECTRON_RUN_AS_NODE=1',
    '--',
    '/opt/code/code',
    '/extensions/runlist/mcp/server.js'
  ]);
});

test('builds a user-scoped Claude Code registration with correctly ordered options', () => {
  assert.deepEqual(buildClaudeAddArguments(options), [
    'mcp',
    'add',
    '--transport',
    'stdio',
    '--env',
    'RUNLIST_PROJECTS_FILE=/data/projects.json',
    '--env',
    'ELECTRON_RUN_AS_NODE=1',
    '--scope',
    'user',
    'runlist',
    '--',
    '/opt/code/code',
    '/extensions/runlist/mcp/server.js'
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
    candidateName: 'runlist-candidate',
    environment: {},
    platform: 'win32'
  }, run);

  assert.deepEqual(calls.slice(0, 3), [
    ['codex.exe', ['--version']],
    [bundledCliPath, ['--version']],
    [bundledCliPath, ['mcp', 'get', 'runlist', '--json']]
  ]);
  assert.deepEqual(calls.slice(3), [
    [bundledCliPath, buildCodexAddArguments(options, 'runlist-candidate')],
    [bundledCliPath, ['mcp', 'remove', 'runlist']],
    [bundledCliPath, buildCodexAddArguments(options)],
    [bundledCliPath, ['mcp', 'remove', 'runlist-candidate']]
  ]);
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
    candidateName: 'runlist-candidate',
    environment: {},
    platform: 'win32'
  }, run);

  assert.deepEqual(calls, [
    ['claude.exe', ['--version']],
    [bundledCliPath, ['--version']],
    [bundledCliPath, ['mcp', 'get', 'runlist']],
    [bundledCliPath, buildClaudeAddArguments(options, 'runlist-candidate')],
    [bundledCliPath, ['mcp', 'remove', '--scope', 'user', 'runlist']],
    [bundledCliPath, buildClaudeAddArguments(options)],
    [bundledCliPath, ['mcp', 'remove', '--scope', 'user', 'runlist-candidate']]
  ]);
});

test('refreshes Codex registration before adding the current extension path', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: '', stderr: '' };
  };

  await registerWithCodex({ ...options, candidateName: 'runlist-candidate' }, run);

  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['mcp', 'get', 'runlist', '--json']],
    ['codex', buildCodexAddArguments(options, 'runlist-candidate')],
    ['codex', ['mcp', 'remove', 'runlist']],
    ['codex', buildCodexAddArguments(options)],
    ['codex', ['mcp', 'remove', 'runlist-candidate']]
  ]);
});

test('refreshes the user-scoped Claude Code registration', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: '', stderr: '' };
  };

  await registerWithClaude({
    ...options,
    candidateName: 'runlist-candidate',
    environment: {}
  }, run);

  assert.deepEqual(calls, [
    ['claude', ['--version']],
    ['claude', ['mcp', 'get', 'runlist']],
    ['claude', buildClaudeAddArguments(options, 'runlist-candidate')],
    ['claude', ['mcp', 'remove', '--scope', 'user', 'runlist']],
    ['claude', buildClaudeAddArguments(options)],
    ['claude', ['mcp', 'remove', '--scope', 'user', 'runlist-candidate']]
  ]);
});

test('allows first-time registration when no prior server exists', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'mcp' && args[1] === 'get') {
      throw new Error("Error: No MCP server named 'runlist' found.");
    }
    return { stdout: '', stderr: '' };
  };

  await registerWithCodex(options, run);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], ['codex', ['mcp', 'get', 'runlist', '--json']]);
  assert.deepEqual(calls[2][1], buildCodexAddArguments(options));
});

test('keeps an existing Codex registration when replacement preflight fails', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'mcp' && args[1] === 'add') {
      throw new Error('configuration write failed');
    }
    return { stdout: '{}', stderr: '' };
  };

  await assert.rejects(registerWithCodex({
    ...options,
    candidateName: 'runlist-candidate'
  }, run), /configuration write failed/);
  assert.equal(calls.some(([, args]) => (
    args[0] === 'mcp' && args[1] === 'remove' && args.at(-1) === 'runlist'
  )), false);
});
