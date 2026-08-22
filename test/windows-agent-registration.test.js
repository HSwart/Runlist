const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildClaudeAddArguments,
  buildCodexAddArguments,
  registerWithClaude,
  registerWithCodex,
  runProcess
} = require('../src/integrations/agent-registration');

const windowsTest = process.platform === 'win32' ? test : test.skip;

function createWindowsCliFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Runlist 100% Windows & spaces-'));
  const npmDirectory = path.join(root, 'App Data', 'npm');
  const cliScript = path.join(root, 'fake agent cli.js');
  const logFile = path.join(root, 'agent calls.jsonl');
  fs.mkdirSync(npmDirectory, { recursive: true });
  fs.writeFileSync(cliScript, [
    "const fs = require('fs');",
    "fs.appendFileSync(process.env.RUNLIST_CLI_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
    "if (process.argv.includes('__fail__')) {",
    "  process.stderr.write('fixture failed on purpose\\n');",
    '  process.exit(7);',
    '}'
  ].join('\n'));

  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(npmDirectory, `${name}.cmd`), [
      '@echo off',
      '"%RUNLIST_TEST_NODE%" "%RUNLIST_TEST_CLI%" %*'
    ].join('\r\n'));
  }

  const environment = {
    ...process.env,
    APPDATA: path.join(root, 'App Data'),
    Path: npmDirectory,
    RUNLIST_CLI_LOG: logFile,
    RUNLIST_TEST_CLI: cliScript,
    RUNLIST_TEST_NODE: process.execPath,
    USERPROFILE: path.join(root, 'User Profile')
  };
  delete environment.PATH;
  const options = {
    candidateName: 'runlist-candidate',
    environment,
    platform: 'win32',
    projectsFile: path.join(root, 'VS Code Data & Projects', 'projects.json'),
    runtimePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    serverPath: path.join(root, 'MCP Bridge', 'server.js')
  };

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    environment,
    logFile,
    npmDirectory,
    options,
    readCalls() {
      return fs.readFileSync(logFile, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  };
}

windowsTest('registers Codex through a Windows npm cmd shim', async (t) => {
  const fixture = createWindowsCliFixture(t);

  await registerWithCodex(fixture.options);

  assert.deepEqual(fixture.readCalls(), [
    ['--version'],
    ['mcp', 'get', 'runlist', '--json'],
    buildCodexAddArguments(fixture.options, 'runlist-candidate'),
    ['mcp', 'remove', 'runlist'],
    buildCodexAddArguments(fixture.options),
    ['mcp', 'remove', 'runlist-candidate']
  ]);
});

windowsTest('registers Claude Code through a Windows npm cmd shim', async (t) => {
  const fixture = createWindowsCliFixture(t);

  await registerWithClaude(fixture.options);

  assert.deepEqual(fixture.readCalls(), [
    ['--version'],
    ['mcp', 'get', 'runlist'],
    buildClaudeAddArguments(fixture.options, 'runlist-candidate'),
    ['mcp', 'remove', '--scope', 'user', 'runlist'],
    buildClaudeAddArguments(fixture.options),
    ['mcp', 'remove', '--scope', 'user', 'runlist-candidate']
  ]);
});

windowsTest('preserves exit details from a Windows cmd shim', async (t) => {
  const fixture = createWindowsCliFixture(t);
  const command = path.join(fixture.npmDirectory, 'codex.cmd');

  await assert.rejects(
    runProcess(command, ['__fail__'], {
      environment: fixture.environment,
      platform: 'win32'
    }),
    (error) => error.exitCode === 7 && /fixture failed on purpose/.test(error.message)
  );
});

windowsTest('reports a missing Windows cmd shim as unavailable', async (t) => {
  const fixture = createWindowsCliFixture(t);
  const command = path.join(fixture.npmDirectory, 'missing.cmd');

  await assert.rejects(
    runProcess(command, ['--version'], {
      environment: fixture.environment,
      platform: 'win32'
    }),
    (error) => error.code === 'ENOENT'
  );
});
