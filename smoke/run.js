const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');
const { terminateProcessTree } = require('../src/lifecycle/project-process');
const { readRootProcess } = require('../src/lifecycle/process-metrics');

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const smokeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-smoke-')));
  const workspacePath = path.join(smokeRoot, 'workspace');
  const userDataPath = path.join(smokeRoot, 'user-data');
  const extensionsPath = path.join(smokeRoot, 'extensions');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(extensionsPath, { recursive: true });

  let failure;
  try {
    for (const phase of ['setup', 'lifecycle']) {
      await runTests({
        ...(localVSCodeExecutable() ? { vscodeExecutablePath: localVSCodeExecutable() } : {}),
        extensionDevelopmentPath,
        extensionTestsPath: path.join(__dirname, `${phase}.js`),
        extensionTestsEnv: {
          RUNLIST_EXTENSION_SMOKE: '1',
          RUNLIST_SMOKE_NODE: process.execPath,
          RUNLIST_SMOKE_ROOT: smokeRoot
        },
        launchArgs: [
          workspacePath,
          '--disable-extensions',
          '--disable-workspace-trust',
          '--skip-release-notes',
          '--skip-welcome',
          `--user-data-dir=${userDataPath}`,
          `--extensions-dir=${extensionsPath}`
        ]
      });
    }
  } catch (error) {
    failure = error;
  }

  const leakedPids = await cleanupExactFixtureProcesses(smokeRoot);
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  if (leakedPids.length) {
    const leakError = new Error(`Smoke fixtures were still running after the extension host closed: ${leakedPids.join(', ')}`);
    if (!failure) {
      failure = leakError;
    }
  }
  if (failure) {
    throw failure;
  }
  process.stdout.write('Runlist extension-host smoke suite passed.\n');
}

function localVSCodeExecutable() {
  if (process.env.RUNLIST_VSCODE_EXECUTABLE_PATH) {
    return process.env.RUNLIST_VSCODE_EXECUTABLE_PATH;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(
      process.env.LOCALAPPDATA,
      'Programs',
      'Microsoft VS Code',
      'Code.exe'
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function cleanupExactFixtureProcesses(smokeRoot) {
  const ownershipFiles = filesInDirectory(
    path.join(
      smokeRoot,
      'user-data',
      'User',
      'globalStorage',
      'hankoswart.runlist',
      'process-ownership'
    ),
    (name) => name.endsWith('.json')
  );
  const processRecords = new Map();
  const fixtureIdentityPath = path.join(smokeRoot, 'fixture-identities.json');
  if (fs.existsSync(fixtureIdentityPath)) {
    try {
      for (const processRecord of JSON.parse(fs.readFileSync(fixtureIdentityPath, 'utf8'))) {
        if (validProcessRecord(processRecord)) {
          processRecords.set(processRecord.pid, processRecord);
        }
      }
    } catch {
      // The disposable smoke profile may contain partial test evidence.
    }
  }
  for (const filePath of ownershipFiles) {
    try {
      const ownership = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const processRecord = {
        pid: ownership.childPid,
        identity: ownership.childIdentity
      };
      if (validProcessRecord(processRecord)) {
        processRecords.set(processRecord.pid, processRecord);
      }
    } catch {
      // A malformed ownership record is still isolated inside the disposable smoke profile.
    }
  }

  const leaked = [];
  for (const processRecord of processRecords.values()) {
    if (await exactProcessIsAlive(processRecord)) {
      leaked.push(processRecord);
    }
  }
  for (const processRecord of leaked) {
    try {
      await terminateProcessTree(processRecord.pid);
    } catch {
      // Report the original leak after making a best-effort exact cleanup attempt.
    }
  }
  return leaked.map((processRecord) => processRecord.pid);
}

function filesInDirectory(directory, predicate) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function validProcessRecord(processRecord) {
  return Number.isInteger(processRecord?.pid)
    && processRecord.pid > 0
    && typeof processRecord.identity === 'string';
}

async function exactProcessIsAlive(processRecord) {
  try {
    return (await readRootProcess(processRecord.pid, process.platform))?.identity
      === processRecord.identity;
  } catch {
    return false;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
