const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');
const { readRootProcess } = require('../src/lifecycle/process-metrics');
const { terminateListenerProcess } = require('../src/ports/port-process');
const { writeFileAtomically } = require('../src/projects/project-store');

const SMOKE_PROCESS_MANIFEST = 'fixture-identities.json';
const SMOKE_PROCESS_MANIFEST_BACKUP = `${SMOKE_PROCESS_MANIFEST}.bak`;
const SMOKE_PROCESS_MANIFEST_CORRUPT = `${SMOKE_PROCESS_MANIFEST}.corrupt`;
const SMOKE_PROCESS_IDENTITY_TIMEOUT_MS = 5000;

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
    const phases = process.env.RUNLIST_SMOKE_PHASES
      ? process.env.RUNLIST_SMOKE_PHASES.split(',').map((phase) => phase.trim()).filter(Boolean)
      : ['setup', 'lifecycle', 'adversarial', 'env-presence'];
    for (const phase of phases) {
      process.stdout.write(`Starting Runlist extension-host smoke phase: ${phase}.\n`);
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

async function cleanupExactFixtureProcesses(smokeRoot, options = {}) {
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
  for (const processRecord of readSmokeProcessManifest(smokeRoot)) {
    if (validProcessRecord(processRecord)) {
      addProcessRecord(processRecords, processRecord);
    }
  }
  for (const filePath of ownershipFiles) {
    try {
      const ownership = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const processRecord = {
        pid: ownership.childPid,
        identity: ownership.childIdentity,
        kind: 'runlist-owned',
        ports: Array.isArray(ownership.services)
          ? ownership.services.map((service) => Number(service?.port)).filter(Number.isInteger)
          : [],
        terminateTree: true
      };
      if (validProcessRecord(processRecord)) {
        addProcessRecord(processRecords, processRecord);
      }
    } catch {
      // A malformed ownership record is still isolated inside the disposable smoke profile.
    }
  }

  const leaked = [];
  for (const processRecord of processRecords.values()) {
    if (processRecord.state !== 'exited' && processIsAlive(processRecord.pid)) {
      leaked.push(processRecord);
    }
  }
  for (const processRecord of leaked) {
    try {
      await (options.terminateProcess || terminateSmokeProcess)(processRecord);
    } catch (error) {
      // Report the original leak after making a best-effort exact cleanup attempt.
      processRecord.cleanupError = error.message;
      try {
        markSmokeProcessCleanupFailed(smokeRoot, processRecord, error.message);
      } catch {
        // Preserve the original cleanup error if the manifest cannot be updated.
      }
    }
  }
  const remaining = [];
  for (const processRecord of leaked) {
    if (processIsAlive(processRecord.pid) || await exactProcessIsAlive(processRecord)) {
      remaining.push(processRecord);
    } else {
      await markSmokeProcessExited(smokeRoot, processRecord);
    }
  }
  return [...new Set(remaining.map((processRecord) => processRecord.pid))];
}

async function terminateSmokeProcess(processRecord, options = {}) {
  if (!validProcessRecord(processRecord)) {
    throw new Error(`Smoke helper PID ${processRecord?.pid || 'unknown'} could not be cleaned because its process identity was not verified; no signal was sent.`);
  }
  const platform = options.platform || process.platform;
  const readIdentity = options.readProcessIdentity || (async (pid, targetPlatform = platform) => (
    await readRootProcess(pid, targetPlatform)
  )?.identity);
  await assertSmokeProcessIdentity(processRecord, readIdentity, platform, options);
  if (platform === 'win32' && processRecord.terminateTree === false) {
    if (!processIsAlive(processRecord.pid)) {
      return;
    }
    await assertSmokeProcessIdentity(processRecord, readIdentity, platform, {
      ...options,
      identityAttempts: 1
    });
    const kill = options.kill || process.kill;
    try {
      kill(processRecord.pid);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
      return;
    }
    await waitForSmokeProcessStopped(processRecord);
    return;
  }
  await terminateListenerProcess(processRecord, {
    ...options,
    platform,
    readProcessIdentity: readIdentity,
    terminateTree: processRecord.terminateTree !== false
  });
}

async function assertSmokeProcessIdentity(processRecord, readIdentity, platform, options = {}) {
  const attempts = Math.max(1, options.identityAttempts ?? (platform === 'win32' ? 3 : 1));
  const delayMs = options.identityRetryDelayMs ?? 25;
  let observed;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    observed = await readIdentity(processRecord.pid, platform);
    if (typeof observed === 'string' && observed === processRecord.identity) {
      return observed;
    }
    if (typeof observed === 'string' && observed !== processRecord.identity) {
      throw new Error(
        `Smoke cleanup refused a changed helper identity (pid ${processRecord.pid}; expected ${processRecord.identity}; observed ${observed}).`
      );
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!processIsAlive(processRecord.pid)) {
    return undefined;
  }
  throw new Error(
    `Smoke cleanup could not re-verify helper identity for PID ${processRecord.pid} (expected ${processRecord.identity}; observed ${observed ?? 'unavailable'}).`
  );
}

async function waitForSmokeProcessStopped(processRecord, timeoutMs = SMOKE_PROCESS_IDENTITY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!(await exactProcessIsAlive(processRecord))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Smoke helper PID ${processRecord.pid} did not exit.`);
}

async function cleanupSmokeProcess(smokeRoot, child, processRecord, message) {
  const record = processRecord || child?.smokeProcessRecord;
  const pid = record?.pid || child?.pid;
  if (!validProcessRecord(record)) {
    throw new Error(
      `Smoke helper PID ${pid || 'unknown'} could not be cleaned because its process identity was not verified; no signal was sent.`
    );
  }
  if (processIsAlive(record.pid)) {
    await terminateSmokeProcess(record);
  }
  await waitForSmokeProcessStopped(record, 5000);
  await markSmokeProcessExited(smokeRoot, record);
}

async function readSmokePidFromFile(pidPath, message, timeoutMs = SMOKE_PROCESS_IDENTITY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      }
    } catch {
      // Keep waiting until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(typeof message === 'string'
    ? message
    : 'Smoke helper did not expose a valid process identifier.');
}

async function registerSmokeProcess(smokeRoot, processOrPid, metadata = {}, options = {}) {
  const pid = Number(typeof processOrPid === 'object' ? processOrPid?.pid : processOrPid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Smoke helper did not expose a valid process identifier.');
  }
  const capturedIdentity = typeof metadata.identity === 'string'
    ? metadata.identity
    : await readSmokeProcessIdentity(pid, options);
  const identity = typeof capturedIdentity === 'string'
    ? capturedIdentity.trim()
    : capturedIdentity;
  if (typeof identity !== 'string' || !identity) {
    throw new Error(`Smoke helper PID ${pid} did not expose a stable process identity.`);
  }

  const nextRecord = {
    pid,
    identity,
    kind: typeof metadata.kind === 'string' && metadata.kind ? metadata.kind : 'smoke-helper',
    name: typeof metadata.name === 'string' && metadata.name ? metadata.name : undefined,
    ports: normalizePorts(metadata.ports),
    terminateTree: metadata.terminateTree !== false,
    state: 'running'
  };
  if (typeof processOrPid === 'object' && processOrPid) {
    processOrPid.smokeProcessRecord = nextRecord;
  }
  try {
    const records = readSmokeProcessManifest(smokeRoot);
    const key = processRecordKey(nextRecord);
    const existingIndex = records.findIndex((record) => processRecordKey(record) === key);
    if (existingIndex >= 0) {
      records[existingIndex] = { ...records[existingIndex], ...nextRecord };
    } else {
      records.push(nextRecord);
    }
    writeSmokeProcessManifest(smokeRoot, records);
  } catch (error) {
    try {
      await cleanupSmokeProcess(smokeRoot, processOrPid, nextRecord, 'Smoke helper registration failed.');
    } catch (cleanupError) {
      error.message = `${error.message}; exact cleanup of smoke helper PID ${pid} also failed: ${cleanupError.message}`;
    }
    throw error;
  }
  return nextRecord;
}

async function markSmokeProcessExited(smokeRoot, processRecord) {
  if (!validProcessRecord(processRecord) || processIsAlive(processRecord.pid)) {
    return false;
  }
  const records = readSmokeProcessManifest(smokeRoot);
  let changed = false;
  const updated = records.map((record) => {
    if (processRecordKey(record) !== processRecordKey(processRecord)) {
      return record;
    }
    changed = true;
    return { ...record, state: 'exited', exitedAt: Date.now() };
  });
  if (changed) {
    writeSmokeProcessManifest(smokeRoot, updated);
  }
  return changed;
}

function readSmokeProcessManifest(smokeRoot) {
  const manifestPath = path.join(smokeRoot, SMOKE_PROCESS_MANIFEST);
  const primary = readManifestFile(manifestPath);
  if (primary.exists && primary.valid) {
    return primary.records;
  }
  const backupPath = path.join(smokeRoot, SMOKE_PROCESS_MANIFEST_BACKUP);
  const backup = readManifestFile(backupPath);
  if (primary.exists && !primary.valid) {
    preserveCorruptManifest(manifestPath, primary.raw);
  }
  if (backup.exists && backup.valid) {
    writeFileAtomically(manifestPath, JSON.stringify(backup.records, null, 2));
    return backup.records;
  }
  if (!primary.exists && !backup.exists) {
    return [];
  }
  throw new Error(
    `Smoke process manifest is corrupt and no valid backup exists: ${manifestPath}`
  );
}

function writeSmokeProcessManifest(smokeRoot, records) {
  if (!Array.isArray(records) || records.some((record) => !validProcessRecord(record))) {
    throw new Error('Smoke process manifest contains an invalid helper identity record.');
  }
  const manifestPath = path.join(smokeRoot, SMOKE_PROCESS_MANIFEST);
  const current = readManifestFile(manifestPath);
  if (current.exists && !current.valid) {
    preserveCorruptManifest(manifestPath, current.raw);
    throw new Error(`Smoke process manifest is corrupt: ${manifestPath}`);
  }
  if (current.exists) {
    writeFileAtomically(
      path.join(smokeRoot, SMOKE_PROCESS_MANIFEST_BACKUP),
      current.raw
    );
  }
  writeFileAtomically(
    manifestPath,
    JSON.stringify(records, null, 2)
  );
}

async function readSmokeProcessIdentity(pid, options = {}) {
  const readIdentity = options.readProcessIdentity || (async (processId) => (
    await readRootProcess(processId, process.platform)
  )?.identity);
  const deadline = Date.now() + (options.identityTimeoutMs ?? SMOKE_PROCESS_IDENTITY_TIMEOUT_MS);
  while (Date.now() <= deadline) {
    try {
      const identity = await readIdentity(pid);
      if (typeof identity === 'string' && identity.trim()) {
        return identity.trim();
      }
    } catch {
      // Process metadata can briefly lag a successful spawn.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

function readManifestFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, valid: false, records: [] };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    const records = JSON.parse(raw);
    return {
      exists: true,
      valid: Array.isArray(records) && records.every(validProcessRecord),
      records: Array.isArray(records) ? records : [],
      raw
    };
  } catch {
    return { exists: true, valid: false, records: [], raw };
  }
}

function preserveCorruptManifest(manifestPath, raw) {
  const corruptPath = path.join(
    path.dirname(manifestPath),
    SMOKE_PROCESS_MANIFEST_CORRUPT
  );
  if (!fs.existsSync(corruptPath)) {
    writeFileAtomically(corruptPath, raw);
  }
}

function addProcessRecord(records, processRecord) {
  const key = processRecordKey(processRecord);
  const existing = records.get(key);
  records.set(key, existing
    ? {
      ...existing,
      ...processRecord,
      ports: [...new Set([...(existing.ports || []), ...(processRecord.ports || [])])]
    }
    : processRecord);
}

function markSmokeProcessCleanupFailed(smokeRoot, processRecord, cleanupError) {
  const records = readSmokeProcessManifest(smokeRoot);
  let changed = false;
  const updated = records.map((record) => {
    if (processRecordKey(record) !== processRecordKey(processRecord)) {
      return record;
    }
    changed = true;
    return { ...record, cleanupError };
  });
  if (changed) {
    writeSmokeProcessManifest(smokeRoot, updated);
  }
  return changed;
}

function processRecordKey(processRecord) {
  return `${processRecord?.pid}:${processRecord?.identity}`;
}

function normalizePorts(ports) {
  return [...new Set((Array.isArray(ports) ? ports : [ports])
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))];
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
    && typeof processRecord.identity === 'string'
    && processRecord.identity.length > 0
    && processRecord.identity.trim() === processRecord.identity;
}

async function exactProcessIsAlive(processRecord) {
  if (!processIsAlive(processRecord?.pid)) {
    return false;
  }
  try {
    return (await readRootProcess(processRecord.pid, process.platform))?.identity
      === processRecord.identity;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupExactFixtureProcesses,
  cleanupSmokeProcess,
  main,
  markSmokeProcessExited,
  readSmokePidFromFile,
  readSmokeProcessManifest,
  registerSmokeProcess,
  terminateSmokeProcess
};
