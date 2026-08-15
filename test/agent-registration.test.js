const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeAddArguments,
  buildCodexAddArguments,
  claudeCommandCandidates,
  codexCommandCandidates,
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
    USERPROFILE: 'C:\\Users\\example'
  }), [
    'claude',
    'C:\\Users\\example\\.local\\bin\\claude.exe'
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
