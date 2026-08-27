const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveLaunchProfile } = require('../projects/launch-profile');
const { execFile, spawn } = require('child_process');
const {
  readOwnedProcessTree,
} = require('./process-metrics');
const {
  currentProcessIdentity,
  processIdentityDecision,
  readProcessIdentity,
  readProcessIdentitySync,
  stableProcessIdentity
} = require('./process-identity');
const {
  runtimeHostOwnerState,
  runtimeProcessOwnerDecision
} = require('./runtime-process-owner');
const {
  createAtomicJsonRecordUpdater,
  processIsAlive,
  readJsonRecord: readJson,
  tryUnlink
} = require('./atomic-json-record');
const { writeFileAtomically } = require('../projects/project-store');
const { projectWithPortOverrides } = require('../ports/service-port-overrides');

const OWNER_HEARTBEAT_TIMEOUT_MS = 10000;
const HOST_IDENTITY_CACHE_TTL_MS = 250;
const EXITED_IDENTITY_WAIT_MS = 250;
const WINDOWS_PROCESS_TREE_SETTLE_MS = 500;
const INVALID_RECORD_GRACE_MS = 2000;
const CURRENT_PROCESS_IDENTITY = currentProcessIdentity({ allowRuntimeFallback: true });
const OWNERSHIP_RECORDS = createAtomicJsonRecordUpdater({
  errorMessage: 'Runlist could not safely update shared process ownership.',
  invalidRecordGraceMs: INVALID_RECORD_GRACE_MS,
  processIdentity: CURRENT_PROCESS_IDENTITY,
  writeFileAtomically
});
const removeInvalidJsonRecord = OWNERSHIP_RECORDS.removeInvalid;
const updateJsonRecord = OWNERSHIP_RECORDS.update;

function projectProcessSpawnOptions(platform = process.platform) {
  return platform === 'win32'
    ? { detached: false, windowsHide: true }
    : { detached: true };
}

function spawnProjectCommand(command, options = {}) {
  const {
    execPath = process.execPath,
    platform = process.platform,
    spawnProcess = spawn,
    supervisorPath = path.join(__dirname, 'process-supervisor.js'),
    ...spawnOptions
  } = options;
  const processOptions = {
    ...spawnOptions,
    ...projectProcessSpawnOptions(platform)
  };
  if (platform === 'darwin' || platform === 'win32') {
    // Windows keeps an identity-gated IPC channel. Darwin keeps the exec-stable
    // supervisor without IPC so Start/Stop semantics stay unchanged there.
    const child = spawnProcess(execPath, [supervisorPath, command], {
      ...processOptions,
      shell: false,
      ...(platform === 'win32'
        ? { stdio: supervisorStdio(processOptions.stdio) }
        : {})
    });
    if (platform === 'win32') {
      child.on?.('message', (message) => {
        if (message?.type === 'runlistCommandStarted'
          && Number.isInteger(message.pid)
          && message.pid > 0) {
          child.runlistCommandPid = message.pid;
        }
      });
    }
    return child;
  }
  return spawnProcess(command, {
    ...processOptions,
    shell: true
  });
}

function supervisorStdio(stdio) {
  if (Array.isArray(stdio)) {
    return stdio.includes('ipc') ? [...stdio] : [...stdio, 'ipc'];
  }
  if (stdio === 'ignore' || stdio === 'inherit' || stdio === 'pipe') {
    return [stdio, stdio, stdio, 'ipc'];
  }
  return ['pipe', 'pipe', 'pipe', 'ipc'];
}

function customStopSpawnOptions(platform = process.platform) {
  return {
    ...projectProcessSpawnOptions(platform),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  };
}

async function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.reject(new Error('Runlist no longer has a valid process identifier for this project.'));
  }

  const platform = options.platform || process.platform;
  const hasExpectedIdentity = Object.prototype.hasOwnProperty.call(options, 'expectedIdentity');
  if (hasExpectedIdentity) {
    const readIdentity = options.readProcessIdentity || readProcessIdentity;
    const currentIdentity = await readIdentity(pid, platform);
    const identityDecision = processIdentityDecision(
      options.expectedIdentity,
      currentIdentity,
      platform,
      pid
    );
    if (identityDecision === 'unavailable') {
      throw new Error('Runlist could not verify the process identity.');
    }
    if (identityDecision === 'mismatch') {
      throw new Error('Runlist did not stop the process because its process identity changed.');
    }
  }
  if (platform !== 'win32') {
    const kill = options.kill || process.kill;
    try {
      kill(-pid, 'SIGTERM');
    } catch (error) {
      if (error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await waitForProcessGroupExit(pid, kill, options);
    return;
  }

  const spawnProcess = options.spawnProcess || spawn;
  return new Promise((resolve, reject) => {
    const taskkill = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    taskkill.stderr?.setEncoding('utf8');
    taskkill.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    taskkill.once('error', reject);
    taskkill.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(lastUsefulLine(stderr) || `taskkill exited with code ${code}.`));
    });
  });
}

async function terminateTrackedProcess(processes, id, options = {}) {
  const child = processes.get(id);
  if (!child) {
    return false;
  }

  const platform = options.platform || process.platform;
  const readIdentity = options.readProcessIdentity || readProcessIdentity;
  const identityRequired = Object.prototype.hasOwnProperty.call(child, 'runlistIdentity');
  const rootExited = child.exitCode != null || child.signalCode != null;
  const expectedIdentity = rootExited
    ? await promisedIdentityWithin(
      child.runlistIdentity,
      options.exitedIdentityWaitMs ?? EXITED_IDENTITY_WAIT_MS
    )
    : await promisedIdentity(child.runlistIdentity);
  const expectedIdentityIsValid = stableProcessIdentity(expectedIdentity);
  if (identityRequired && !expectedIdentityIsValid) {
    if (!rootExited) {
      throw new Error('Runlist could not verify the launched process identity.');
    }
    if (!await exitedRootHasNoRemainingProcesses(child.pid, platform, options)) {
      throw new Error(platform === 'win32'
        ? 'Runlist could not verify the launched process tree after its root exited.'
        : 'Runlist could not verify the launched process group after its root exited.');
    }
    processes.delete(id);
    return true;
  }
  if (expectedIdentityIsValid) {
    let currentIdentity;
    try {
      currentIdentity = await readIdentity(child.pid, platform);
    } catch {
      currentIdentity = undefined;
    }
    const identityDecision = processIdentityDecision(
      expectedIdentity,
      currentIdentity,
      platform,
      child.pid
    );
    if (identityDecision === 'mismatch') {
      throw new Error('Runlist did not stop the process because its process identity changed.');
    }
    if (identityDecision === 'unavailable' && !rootExited) {
      const liveness = await trackedProcessLiveness(child.pid, platform, options);
      if (liveness === false && options.allowMissing) {
        processes.delete(id);
        return true;
      }
      throw new Error('Runlist could not verify the launched process identity.');
    }
  }

  processes.delete(id);
  try {
    if (rootExited && platform === 'win32') {
      const knownTree = await promisedProcessTree(child.runlistProcessTree);
      await terminateExitedWindowsTree(child.pid, expectedIdentity, {
        ...options,
        knownTree,
        readProcessIdentity: readIdentity
      });
    } else {
      await terminateProcessTree(child.pid, {
        ...options,
        platform,
        ...(expectedIdentityIsValid && !rootExited ? {
          expectedIdentity,
          readProcessIdentity: readIdentity
        } : {})
      });
    }
  } catch (error) {
    processes.set(id, child);
    throw error;
  }
  return true;
}

async function exitedRootHasNoRemainingProcesses(pid, platform, options = {}) {
  if (platform === 'win32') {
    const readTree = options.readOwnedProcessTree || readOwnedProcessTree;
    const remaining = await readTree(pid, 'win32', options);
    return Array.isArray(remaining) && remaining.length === 0;
  }
  const liveness = await trackedProcessLiveness(pid, platform, options);
  return liveness === false;
}

async function terminateExitedWindowsTree(rootPid, rootIdentity, options = {}) {
  const readTree = options.readOwnedProcessTree || readOwnedProcessTree;
  let rows = await readTree(rootPid, 'win32', options);
  const visibleRoot = rows.find((row) => row.pid === rootPid);
  if (visibleRoot) {
    if (processIdentityDecision(rootIdentity, visibleRoot.identity, 'win32', rootPid) !== 'match') {
      throw new Error('Runlist did not stop the process because its process identity changed.');
    }
    try {
      await terminateProcessTree(rootPid, {
        ...options,
        platform: 'win32',
        expectedIdentity: rootIdentity,
        readProcessIdentity: options.readProcessIdentity || readProcessIdentity
      });
      rows = await readTree(rootPid, 'win32', options);
    } catch (error) {
      rows = await readTree(rootPid, 'win32', options);
      const currentRoot = rows.find((row) => row.pid === rootPid);
      if (currentRoot) {
        if (processIdentityDecision(rootIdentity, currentRoot.identity, 'win32', rootPid) !== 'match') {
          throw new Error('Runlist did not stop the process because its process identity changed.');
        }
        throw error;
      }
    }
  }
  const rootStartedAt = windowsIdentityStartedAt(rootIdentity);
  const candidates = new Map();
  for (const row of [...(options.knownTree || []), ...rows]) {
    const childStartedAt = windowsIdentityStartedAt(row.identity);
    if (row.pid !== rootPid
      && (rootStartedAt === undefined
        || (childStartedAt !== undefined && childStartedAt >= rootStartedAt))) {
      candidates.set(row.pid, row);
    }
  }
  const surviving = [];
  for (const candidate of candidates.values()) {
    const currentIdentity = await (options.readProcessIdentity || readProcessIdentity)(
      candidate.pid,
      'win32'
    );
    if (processIdentityDecision(
      candidate.identity,
      currentIdentity,
      'win32',
      candidate.pid
    ) === 'match') {
      surviving.push(candidate);
    }
  }
  const survivingPids = new Set(surviving.map((row) => row.pid));
  for (const descendant of surviving.filter((row) => !survivingPids.has(row.parentPid))) {
    await terminateProcessTree(descendant.pid, {
      ...options,
      platform: 'win32',
      expectedIdentity: descendant.identity,
      readProcessIdentity: options.readProcessIdentity || readProcessIdentity
    });
  }
}

async function promisedProcessTree(value) {
  if (!value) {
    return [];
  }
  try {
    const rows = await value;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function windowsIdentityStartedAt(identity) {
  const value = String(identity || '').split(':').at(-1);
  return /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function shutdownTrackedProcesses(processes, processOwnership, portReservations, options = {}) {
  const terminate = options.terminateTrackedProcess || terminateTrackedProcess;
  const terminationOptions = options.terminationOptions || {};
  return Promise.allSettled([...processes.keys()].map(async (id) => {
    await terminate(processes, id, terminationOptions);
    processOwnership.release(id);
    portReservations.release(id);
    return true;
  }));
}

function detachedServicePorts(ownership) {
  if (!Array.isArray(ownership?.services)) {
    return [];
  }
  return [...new Set(ownership.services
    .map((service) => service?.port)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))]
    .sort((left, right) => left - right);
}

function normalizeDetachedServiceListeners(ownership, listeners, requireEveryPort = false) {
  const ports = detachedServicePorts(ownership);
  if (ports.length === 0 || !Array.isArray(listeners)) {
    return undefined;
  }
  const allowedPorts = new Set(ports);
  const seen = new Set();
  const normalized = [];
  for (const listener of listeners) {
    if (!listener
      || !allowedPorts.has(listener.port)
      || !Number.isInteger(listener.pid)
      || listener.pid <= 0
      || !stableProcessIdentity(listener.identity)) {
      return undefined;
    }
    const key = `${listener.port}:${listener.pid}:${listener.identity}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    normalized.push({
      port: listener.port,
      pid: listener.pid,
      identity: listener.identity
    });
  }
  normalized.sort((left, right) => left.port - right.port
    || left.pid - right.pid
    || left.identity.localeCompare(right.identity));
  if (requireEveryPort
    && ports.some((port) => !normalized.some((listener) => listener.port === port))) {
    return undefined;
  }
  return normalized;
}

function detachedServiceListenersFingerprint(ownership, listeners) {
  const normalized = normalizeDetachedServiceListeners(ownership, listeners, true);
  return normalized ? JSON.stringify(normalized) : undefined;
}

function normalizeDetachedPortGeneration(ownership, generation) {
  const ports = detachedServicePorts(ownership);
  const entries = generation instanceof Map
    ? [...generation].map(([port, token]) => ({ port, token }))
    : generation;
  if (ports.length === 0 || !Array.isArray(entries) || entries.length !== ports.length) {
    return undefined;
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    if (!entry
      || !ports.includes(entry.port)
      || seen.has(entry.port)
      || !stableProcessIdentity(entry.token)) {
      return undefined;
    }
    seen.add(entry.port);
    normalized.push({ port: entry.port, token: entry.token });
  }
  normalized.sort((left, right) => left.port - right.port);
  return normalized;
}

function detachedPortGenerationFingerprint(ownership, generation) {
  const normalized = normalizeDetachedPortGeneration(ownership, generation);
  return normalized ? JSON.stringify(normalized) : undefined;
}

function detachedServiceCleanupClaimMatches(current, projectId, claim) {
  return validOwnership(current, projectId)
    && current.detached === true
    && current.token === claim.token
    && current.state === 'reclaiming'
    && current.detachedReclaimToken === claim.reclaimToken
    && Object.prototype.hasOwnProperty.call(current, 'detachedServiceListeners')
      === claim.hasDetachedServiceListeners
    && JSON.stringify(current.services) === claim.servicesFingerprint
    && current.detachedChildPid === claim.detachedChildPid
    && current.detachedChildIdentity === claim.detachedChildIdentity
    && detachedServiceListenersFingerprint(
      current,
      current.detachedServiceListeners
    ) === claim.detachedServiceListenersFingerprint
    && detachedPortGenerationFingerprint(
      current,
      current.detachedPortGeneration
    ) === claim.detachedPortGenerationFingerprint;
}

function detachedServiceIdentityDecision(ownership, portStatus, listeners) {
  if (ownership?.detached !== true) {
    return 'uncertain';
  }
  const ports = detachedServicePorts(ownership);
  const openPorts = Array.isArray(portStatus?.openPorts) ? portStatus.openPorts : undefined;
  if (ports.length === 0
    || !openPorts
    || typeof portStatus.allOpen !== 'boolean'
    || typeof portStatus.anyOpen !== 'boolean') {
    return 'uncertain';
  }
  const openPortSet = new Set(openPorts);
  if (openPortSet.size !== openPorts.length
    || openPorts.some((port) => !ports.includes(port))
    || portStatus.allOpen !== (openPortSet.size === ports.length)
    || portStatus.anyOpen !== (openPortSet.size > 0)) {
    return 'uncertain';
  }
  const current = normalizeDetachedServiceListeners(ownership, listeners);
  if (!current) {
    return 'uncertain';
  }
  const expected = normalizeDetachedServiceListeners(
    ownership,
    ownership.detachedServiceListeners,
    true
  );
  if (!expected) {
    return current.length === 0 && openPortSet.size === 0 ? 'missing' : 'uncertain';
  }
  const expectedKeys = new Set(expected.map((listener) => (
    `${listener.port}:${listener.pid}:${listener.identity}`
  )));
  if (current.some((listener) => expectedKeys.has(
    `${listener.port}:${listener.pid}:${listener.identity}`
  ))) {
    return 'present';
  }
  const currentPorts = new Set(current.map((listener) => listener.port));
  if (ports.every((port) => currentPorts.has(port))) {
    return 'replaced';
  }
  if (currentPorts.size === openPortSet.size
    && [...currentPorts].every((port) => openPortSet.has(port))) {
    return 'missing';
  }
  return 'uncertain';
}

async function trackedProcessLiveness(pid, platform, options = {}) {
  const isAlive = options.isProcessAlive || processIsAlive;
  let pidAlive;
  try {
    pidAlive = await isAlive(pid);
  } catch {
    return undefined;
  }
  if (pidAlive === true) {
    return true;
  }
  if (pidAlive !== false || platform === 'win32') {
    return pidAlive === false ? false : undefined;
  }

  const kill = options.kill || process.kill;
  try {
    return await processGroupIsAlive(pid, kill, options);
  } catch {
    return undefined;
  }
}

function shouldRequestRemoteCustomStop(project, ownership, hasLocalProcess, locallyOwnedWithoutHandle) {
  return Boolean(project?.stopCommand
    && ownership?.ownerAvailable
    && !ownership.detached
    && !hasLocalProcess
    && !locallyOwnedWithoutHandle);
}

function projectStopStrategy(project, ownership) {
  if (!project) {
    return project;
  }
  const selectedProject = resolveLaunchProfile(project);
  if (!ownership) {
    return selectedProject;
  }
  const launchProject = {
    ...selectedProject,
    ...(typeof ownership.cwd === 'string' ? { folder: ownership.cwd } : {}),
    ...(typeof ownership.startCommand === 'string'
      ? { startCommand: ownership.startCommand }
      : {}),
    ...(typeof ownership.stopCommand === 'string'
      ? { stopCommand: ownership.stopCommand }
      : {}),
    ...(Array.isArray(ownership.services)
      ? { services: ownership.services.map((service) => ({ ...service })) }
      : {}),
    ...(typeof ownership.launchProfileId === 'string'
      ? { activeLaunchProfileId: ownership.launchProfileId }
      : {}),
    ...(typeof ownership.launchProfileName === 'string'
      ? { activeLaunchProfileName: ownership.launchProfileName }
      : {})
  };
  try {
    return projectWithPortOverrides(launchProject, ownership.portOverrides);
  } catch {
    return launchProject;
  }
}

function transitionOwnedRuntimeState(
  processOwnership,
  portReservations,
  projectId,
  state,
  details = {}
) {
  const ownershipUpdated = processOwnership.setState(projectId, state, details);
  const reservationsUpdated = ownershipUpdated
    ? portReservations.setState(projectId, state)
    : false;
  return { ownershipUpdated, reservationsUpdated };
}

function markOwnedRuntimeDetached(processOwnership, portReservations, projectId) {
  const ownershipUpdated = processOwnership.markDetached(projectId);
  const reservationsUpdated = ownershipUpdated
    ? portReservations.markDetached(projectId)
    : false;
  return { ownershipUpdated, reservationsUpdated };
}

function recordStartedProcess(
  processOwnership,
  portReservations,
  project,
  child,
  details = {},
  options = {}
) {
  const identity = processOwnership.trackProcessIdentity(project.id, child.pid);
  child.runlistIdentity = identity;
  child.runlistProcessTree = captureInitialProcessTree(child.pid, identity, options);
  const ownershipReady = Promise.all([identity, child.runlistProcessTree])
    .then(([value]) => value);
  void ownershipReady.finally(() => releaseSupervisorIdentityHold(child)).catch(() => undefined);
  const portGeneration = portReservations.capture(project.id);
  const recorded = processOwnership.setProcess(project.id, child.pid, {
    ...details,
    cwd: project.folder,
    identityRequired: true,
    startCommand: project.startCommand,
    stopCommand: project.stopCommand || '',
    services: project.services || [],
    launchProfileId: project.activeLaunchProfileId,
    launchProfileName: project.activeLaunchProfileName
  });
  if (!recorded) {
    throw new Error('Runlist lost process ownership while recording the launched process.');
  }

  const recordedPorts = portReservations.setProcess(project.id, child.pid, undefined, portGeneration);
  const expectedPorts = new Set((project.services || [])
    .map((service) => service.port)
    .filter((port) => Number.isInteger(port))).size;
  if (recordedPorts !== expectedPorts) {
    throw new Error('Runlist lost a port reservation while recording the launched process.');
  }
  void identity.then((value) => {
    if (value) {
      portReservations.setProcess(project.id, child.pid, value, portGeneration);
    }
  }).catch(() => undefined);
  return ownershipReady;
}

async function captureInitialProcessTree(pid, identity, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return [];
  }
  const expectedIdentity = await identity;
  if (!stableProcessIdentity(expectedIdentity)) {
    throw new Error('Runlist could not verify the launched Windows process identity.');
  }
  try {
    await delay(options.processTreeSettleMs ?? WINDOWS_PROCESS_TREE_SETTLE_MS);
    const readTree = options.readOwnedProcessTree || readOwnedProcessTree;
    const rows = await readTree(pid, platform, options);
    const root = rows.find((row) => row.pid === pid);
    if (!root || processIdentityDecision(expectedIdentity, root.identity, platform, pid) !== 'match') {
      throw new Error('Runlist could not verify the launched Windows process tree.');
    }
    return rows;
  } catch (error) {
    if (error?.message === 'Runlist could not verify the launched Windows process tree.') {
      throw error;
    }
    throw new Error(
      `Runlist could not verify the launched Windows process tree: ${error?.message || 'process inspection failed.'}`,
      { cause: error }
    );
  }
}

function releaseSupervisorIdentityHold(child) {
  if (typeof child?.send !== 'function' || child.connected !== true) {
    return;
  }
  try {
    child.send({ type: 'runlistIdentityCaptured' });
  } catch {
    // Disconnecting still releases a supervisor whose IPC channel is usable enough to observe closure.
  }
  try {
    child.disconnect();
  } catch {
    // The process may have exited while identity capture settled.
  }
}

async function rollbackStartedProcess(processes, id, processOwnership, portReservations, options = {}) {
  const terminate = options.terminateTrackedProcess || terminateTrackedProcess;
  try {
    if (processes.has(id)) {
      await terminate(processes, id, options.terminationOptions || {});
    }
  } catch (error) {
    return { stopped: false, error };
  }
  processOwnership.release(id);
  portReservations.release(id);
  return { stopped: true };
}

async function restartProjectSafely(restartingProjectIds, id, actions) {
  if (restartingProjectIds.has(id) || (actions.canRestart && !actions.canRestart())) {
    return false;
  }
  restartingProjectIds.add(id);
  try {
    if (!await actions.stop()) {
      return false;
    }
    if (!await actions.waitForStop()) {
      return false;
    }
    return await actions.start() !== false;
  } finally {
    restartingProjectIds.delete(id);
  }
}

async function handoffProjectSafely(handoffProjectIds, id, actions) {
  if (handoffProjectIds.has(id)) {
    return false;
  }
  handoffProjectIds.add(id);
  let reservationHeld = false;
  let reservationTransferred = false;
  try {
    if (!await actions.reserveRequested()) {
      return false;
    }
    reservationHeld = true;
    const conflict = await actions.currentConflict();
    if (!conflict || !await actions.stop(conflict)) {
      return false;
    }
    if (!await actions.waitForStop(conflict)) {
      return false;
    }
    reservationTransferred = Boolean(await actions.start(conflict));
    return reservationTransferred;
  } finally {
    if (reservationHeld && !reservationTransferred) {
      await actions.releaseRequested();
    }
    handoffProjectIds.delete(id);
  }
}

async function cleanupTrackedProcessForDeletion(processes, id, project, stopProject, options = {}) {
  if (!processes.has(id)) {
    return false;
  }
  if (!project || project.reviewRequired) {
    return terminateTrackedProcess(processes, id, options);
  }

  return Boolean(await stopProject(project));
}

async function waitForProcessGroupExit(pid, kill, options) {
  const termDeadline = Date.now() + (options.terminateTimeoutMs ?? 5000);
  while (await processGroupIsAlive(pid, kill, options)) {
    if (Date.now() >= termDeadline) {
      if (!await posixEscalationTargetIsCurrent(pid, kill, options)) {
        return;
      }
      try {
        kill(-pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
      break;
    }
    await delay(options.pollIntervalMs ?? 100);
  }

  const killDeadline = Date.now() + (options.killTimeoutMs ?? 1000);
  while (await processGroupIsAlive(pid, kill, options)) {
    if (Date.now() >= killDeadline) {
      throw new Error('the launched process tree did not exit after Runlist terminated it.');
    }
    await delay(options.pollIntervalMs ?? 100);
  }
}

async function posixEscalationTargetIsCurrent(pid, kill, options) {
  if (!Object.prototype.hasOwnProperty.call(options, 'expectedIdentity')) {
    return true;
  }
  if (!await processGroupIsAlive(pid, kill, options)) {
    return false;
  }

  const readGroup = options.readProcessGroup || readPosixProcessGroup;
  let members;
  try {
    members = await readGroup(pid, options);
  } catch {
    if (!await processGroupIsAlive(pid, kill, options)) {
      return false;
    }
    throw new Error('Runlist could not verify the launched process group before force stopping it.');
  }
  if (!Array.isArray(members) || !members.some((memberPid) => Number(memberPid) === pid)) {
    if (!await processGroupIsAlive(pid, kill, options)) {
      return false;
    }
    throw new Error('Runlist did not force stop the process because its process group changed.');
  }

  const readIdentity = options.readProcessIdentity || readProcessIdentity;
  let currentIdentity;
  try {
    currentIdentity = await readIdentity(pid, options.platform || process.platform);
  } catch {
    currentIdentity = undefined;
  }
  const identityDecision = processIdentityDecision(
    options.expectedIdentity,
    currentIdentity,
    options.platform || process.platform,
    pid
  );
  if (identityDecision === 'unavailable') {
    if (!await processGroupIsAlive(pid, kill, options)) {
      return false;
    }
    throw new Error('Runlist could not verify the process identity before force stopping it.');
  }
  if (identityDecision === 'mismatch') {
    throw new Error('Runlist did not force stop the process because its process identity changed.');
  }
  return true;
}

async function processGroupIsAlive(pid, kill, options) {
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      const readGroup = options.readProcessGroup || readPosixProcessGroup;
      try {
        return (await readGroup(pid, {
          ...options,
          requireProcessGroupRoot: false
        })).length > 0;
      } catch {
        // Preserve the original permission failure when the fallback cannot prove the group is empty.
      }
    }
    throw error;
  }
}

function readPosixProcessGroup(processGroupId, options = {}) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    return Promise.reject(new Error('Runlist no longer has a valid process group identifier.'));
  }
  const runFile = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    runFile('ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 64 * 1024,
      timeout: options.processGroupProbeTimeoutMs ?? 1000,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parsePosixProcessGroupRows(
          stdout,
          processGroupId,
          options.requireProcessGroupRoot !== false
        ));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function parsePosixProcessGroupRows(output, processGroupId, requireRoot = true) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('Runlist no longer has a valid process group identifier.');
  }
  const members = [];
  const seenPids = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const row = line.trim();
    if (!row) {
      continue;
    }
    const match = /^([1-9]\d*)\s+([1-9]\d*)$/.exec(row);
    if (!match) {
      throw new Error('Runlist could not verify the launched process group listing.');
    }
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid)
      || !Number.isSafeInteger(pgid)
      || seenPids.has(pid)) {
      throw new Error('Runlist could not verify the launched process group listing.');
    }
    seenPids.add(pid);
    if (pgid === processGroupId) {
      members.push(pid);
    }
  }
  if (requireRoot && !members.includes(processGroupId)) {
    throw new Error('Runlist could not verify the launched process group root.');
  }
  return members;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ProcessOwnershipStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.pid = options.pid || process.pid;
    this.platform = options.platform || process.platform;
    this.isProcessAlive = options.isProcessAlive || processIsAlive;
    this.readProcessIdentity = options.readProcessIdentity || readProcessIdentity;
    this.readHostProcessIdentity = options.readHostProcessIdentity
      || options.readProcessIdentitySync
      || ((pid, platform) => readProcessIdentitySync(pid, platform, options));
    this.now = options.now || Date.now;
    this.ownerHeartbeatTimeoutMs = options.ownerHeartbeatTimeoutMs ?? OWNER_HEARTBEAT_TIMEOUT_MS;
    this.invalidRecordGraceMs = options.invalidRecordGraceMs ?? INVALID_RECORD_GRACE_MS;
    this.owned = new Map();
    this.pendingProcessIdentities = new Map();
    this.consumedStopRequests = new Map();
    this.stopRequestFailureKeys = new Map();
    this.stopRequestFailures = new Map();
    this.hostIdentityCache = new Map();
    this.hostIdentityCacheTtlMs = options.hostIdentityCacheTtlMs ?? HOST_IDENTITY_CACHE_TTL_MS;
    this.onDiagnostic = typeof options.onDiagnostic === 'function'
      ? options.onDiagnostic
      : undefined;
    let capturedHostIdentity;
    if (stableProcessIdentity(options.hostIdentity)) {
      capturedHostIdentity = options.hostIdentity;
    } else {
      try {
        capturedHostIdentity = this.readHostProcessIdentity(this.pid, this.platform);
      } catch {
        capturedHostIdentity = undefined;
      }
    }
    this.hostIdentity = stableProcessIdentity(capturedHostIdentity)
      ? capturedHostIdentity
      : undefined;
    fs.mkdirSync(directory, { recursive: true });
  }

  reserve(projectId) {
    if (!stableProcessIdentity(this.hostIdentity)) {
      this.diagnose('reserve.blocked', {
        projectId,
        reasonCode: 'host-identity-unavailable',
        identityDecision: 'unavailable'
      });
      return { kind: 'uncertain' };
    }
    const ownershipPath = this.ownershipPath(projectId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = crypto.randomUUID();
      let descriptor;
      try {
        descriptor = fs.openSync(ownershipPath, 'wx', 0o600);
        const ownership = {
          projectId,
          hostPid: this.pid,
          platform: this.platform,
          state: 'starting',
          heartbeatAt: this.now(),
          token,
          ...(stableProcessIdentity(this.hostIdentity)
            ? { hostIdentity: this.hostIdentity }
            : {})
        };
        fs.writeFileSync(descriptor, JSON.stringify(ownership));
        fs.closeSync(descriptor);
        this.owned.set(projectId, { ownershipPath, token });
        const existingRequest = readJson(this.stopRequestPath(projectId));
        if (existingRequest && existingRequest.token !== token) {
          updateJsonRecord(
            this.stopRequestPath(projectId),
            (request) => sameStopRequest(request, existingRequest)
          );
        }
        this.diagnose('reserve.acquired', {
          projectId,
          reasonCode: 'ownership-created',
          identityDecision: 'match'
        });
        return undefined;
      } catch (error) {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
          tryUnlink(ownershipPath);
        }
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }

      const existing = readJson(ownershipPath);
      if (!validOwnership(existing, projectId)) {
        if (removeInvalidJsonRecord(ownershipPath, this.invalidRecordGraceMs, this.now())) {
          this.diagnose('reserve.stale-recovered', {
            projectId,
            reasonCode: 'invalid-record',
            identityDecision: 'unavailable'
          });
          continue;
        }
        this.diagnose('reserve.blocked', {
          projectId,
          reasonCode: 'invalid-record',
          identityDecision: 'unavailable'
        });
        return { kind: 'uncertain' };
      }
      const hostDecision = this.hostIdentityDecision(existing);
      const childLiveness = this.childProcessLiveness(existing);
      const processAlive = childLiveness === true;
      const heartbeatExpired = this.ownerHeartbeatExpired(existing);
      if (existing.detached
        || (hostDecision === 'match' && !heartbeatExpired)
        || (childLiveness !== false && hostDecision !== 'mismatch')) {
        this.diagnose('reserve.blocked', {
          projectId,
          reasonCode: existing.detached
            ? 'detached-ownership'
            : hostDecision === 'match' && !heartbeatExpired
              ? 'owner-available'
              : 'ownership-uncertain',
          identityDecision: hostDecision,
          processActive: processAlive
        });
        return {
          kind: hostDecision === 'match' && !heartbeatExpired ? 'owned' : 'uncertain',
          ownership: existing
        };
      }
      const removed = updateJsonRecord(
        ownershipPath,
        (current) => this.canReclaimOwnership(
          current,
          existing,
          hostDecision
        )
      );
      if (removed) {
        this.diagnose('reserve.stale-recovered', {
          projectId,
          reasonCode: hostDecision === 'mismatch'
            ? 'owner-identity-changed'
            : 'owner-absent',
          identityDecision: hostDecision,
          processActive: processAlive
        });
        updateJsonRecord(
          this.stopRequestPath(projectId),
          (request) => request?.token === existing.token
        );
      }
    }
    this.diagnose('reserve.blocked', {
      projectId,
      reasonCode: 'ownership-changed',
      identityDecision: 'unavailable'
    });
    return { kind: 'uncertain' };
  }

  diagnose(event, details) {
    try {
      this.onDiagnostic?.(event, details);
    } catch {
      // Local diagnostics must never alter process ownership behavior.
    }
  }

  setProcess(projectId, childPid, details = {}) {
    return this.updateOwned(projectId, (ownership) => ({
      ...ownership,
      childPid,
      ...(Number.isFinite(details.launchedAt)
        ? { launchedAt: details.launchedAt }
        : {}),
      ...(Number.isFinite(details.readinessDeadline)
        ? { readinessDeadline: details.readinessDeadline }
        : {}),
      ...(Number.isFinite(details.readyAt)
        ? { readyAt: details.readyAt }
        : {}),
      ...(typeof details.cwd === 'string'
        ? { cwd: details.cwd }
        : {}),
      ...(typeof details.startCommand === 'string'
        ? { startCommand: details.startCommand }
        : {}),
      ...(typeof details.stopCommand === 'string'
        ? { stopCommand: details.stopCommand }
        : {}),
      ...(Array.isArray(details.services)
        ? { services: details.services.map((service) => ({ ...service })) }
        : {}),
      ...(typeof details.launchProfileId === 'string'
        ? { launchProfileId: details.launchProfileId }
        : {}),
      ...(typeof details.launchProfileName === 'string'
        ? { launchProfileName: details.launchProfileName }
        : {}),
      ...(details.ownershipKind === 'compose'
        ? { ownershipKind: 'compose' }
        : {}),
      ...(typeof details.composePath === 'string' && details.composePath.trim()
        ? { composePath: details.composePath.trim() }
        : {}),
      ...(Array.isArray(details.composeServices)
        ? { composeServices: details.composeServices.map((name) => String(name)) }
        : {}),
      ...(validRuntimePortOverrides(details.portOverrides)
        ? { portOverrides: details.portOverrides.map((override) => ({ ...override })) }
        : {}),
      ...(stableProcessIdentity(details.childIdentity)
        ? { childIdentity: details.childIdentity }
        : {}),
      ...(details.identityRequired === true
        || (Object.prototype.hasOwnProperty.call(details, 'childIdentity')
          && !stableProcessIdentity(details.childIdentity))
        ? { identityRequired: true }
        : {}),
      state: details.state || 'running'
    }), { allowDetached: false });
  }

  async trackProcessIdentity(projectId, childPid) {
    const tracked = {
      childPid,
      promise: Promise.resolve(this.readProcessIdentity(childPid, this.platform))
        .catch(() => undefined)
    };
    this.pendingProcessIdentities.set(projectId, tracked);
    const identity = await tracked.promise;
    if (this.pendingProcessIdentities.get(projectId) === tracked) {
      this.pendingProcessIdentities.delete(projectId);
    }
    if (stableProcessIdentity(identity) && this.owns(projectId, childPid)) {
      try {
        this.updateOwned(projectId, (ownership) => ({
          ...ownership,
          childIdentity: identity
        }));
      } catch {
        return identity;
      }
    } else if (stableProcessIdentity(identity)) {
      const owned = this.owned.get(projectId);
      const current = owned ? readJson(owned.ownershipPath) : undefined;
      if (current?.token === owned?.token
        && current.detached === true
        && current.detachedChildPid === childPid) {
        try {
          this.updateOwned(projectId, (ownership) => ({
            ...ownership,
            detachedChildIdentity: identity
          }));
        } catch {
          return identity;
        }
      }
    }
    return identity;
  }

  setState(projectId, state, details = {}) {
    return this.updateOwned(projectId, (ownership) => ({
      ...ownership,
      ...(Number.isFinite(details.readyAt)
        ? { readyAt: details.readyAt }
        : {}),
      state
    }));
  }

  touchOwned() {
    for (const projectId of [...this.owned.keys()]) {
      try {
        this.updateOwned(projectId, (ownership) => ownership);
      } catch {
        // Heartbeats are best effort; the next independent tick can retry.
      }
    }
  }

  claimDetachedStop(projectId, expectedToken) {
    const ownershipPath = this.ownershipPath(projectId);
    const ownership = readJson(ownershipPath);
    if (!validOwnership(ownership, projectId)
      || ownership.detached !== true
      || (expectedToken && ownership.token !== expectedToken)
      || ['stopping', 'reclaiming'].includes(ownership.state)) {
      return false;
    }
    const priorState = [
      'not-responding',
      'starting',
      'running',
      'detached'
    ].includes(ownership.state)
      ? ownership.state
      : 'detached';
    const claimed = updateJsonRecord(
      ownershipPath,
      (current) => validOwnership(current, projectId)
        && current.detached === true
        && current.token === ownership.token
        && (!expectedToken || current.token === expectedToken)
        && !['stopping', 'reclaiming'].includes(current.state),
      (current) => ({
        ...current,
        state: 'stopping',
        heartbeatAt: this.now()
      })
    );
    return claimed ? { token: ownership.token, priorState } : false;
  }

  rollbackDetachedStop(projectId, expectedToken, retryState = 'detached') {
    if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
      return false;
    }
    const state = [
      'not-responding',
      'starting',
      'running',
      'detached'
    ].includes(retryState)
      ? retryState
      : 'detached';
    const ownershipPath = this.ownershipPath(projectId);
    const ownership = readJson(ownershipPath);
    if (!validOwnership(ownership, projectId)
      || ownership.token !== expectedToken
      || ownership.detached !== true
      || ownership.state !== 'stopping') {
      return false;
    }
    return updateJsonRecord(
      ownershipPath,
      (current) => validOwnership(current, projectId)
        && current.token === expectedToken
        && current.detached === true
        && current.state === 'stopping',
      (current) => ({
        ...current,
        state,
        heartbeatAt: this.now()
      })
    );
  }

  markDetached(projectId) {
    return this.updateOwned(projectId, (ownership) => {
      const {
        childIdentity,
        childPid,
        identityRequired,
        ...launch
      } = ownership;
      return {
        ...launch,
        ...(Number.isInteger(childPid) && childPid > 0
          ? { detachedChildPid: childPid }
          : {}),
        ...(stableProcessIdentity(childIdentity)
          ? { detachedChildIdentity: childIdentity }
          : {}),
        detached: true,
        state: 'detached'
      };
    });
  }

  recordDetachedServiceListeners(projectId, expectedToken, listeners) {
    const owned = this.owned.get(projectId);
    if (!owned || owned.token !== expectedToken) {
      return false;
    }
    const ownership = readJson(owned.ownershipPath);
    const normalized = normalizeDetachedServiceListeners(ownership, listeners, true);
    if (!normalized) {
      return false;
    }
    return updateJsonRecord(
      owned.ownershipPath,
      (current) => current?.token === expectedToken
        && current.hostPid === this.pid
        && this.hostIdentityMatches(current)
        && JSON.stringify(current.services) === JSON.stringify(ownership.services),
      (current) => {
        const { detachedServiceMissingAt, ...retained } = current;
        return {
          ...retained,
          detachedServiceListeners: normalized,
          heartbeatAt: this.now()
        };
      }
    );
  }

  claimDetachedServiceCleanup(
    projectId,
    expectedToken,
    expectedListeners,
    decision,
    confirmationMs,
    portGeneration
  ) {
    if (!['missing', 'present', 'replaced', 'uncertain'].includes(decision)
      || !Number.isFinite(confirmationMs)
      || confirmationMs < 0) {
      return false;
    }
    const ownershipPath = this.ownershipPath(projectId);
    const ownership = readJson(ownershipPath);
    if (!validOwnership(ownership, projectId)
      || ownership.detached !== true
      || ownership.token !== expectedToken
      || ownership.state === 'stopping'
      || ownership.state === 'reclaiming') {
      return false;
    }
    const currentFingerprint = detachedServiceListenersFingerprint(
      ownership,
      ownership.detachedServiceListeners
    );
    const expectedFingerprint = detachedServiceListenersFingerprint(
      ownership,
      expectedListeners
    );
    const currentHasListeners = Object.prototype.hasOwnProperty.call(
      ownership,
      'detachedServiceListeners'
    );
    const expectedHasListeners = expectedListeners !== undefined;
    if (currentHasListeners !== expectedHasListeners
      || (currentHasListeners && (!currentFingerprint || currentFingerprint !== expectedFingerprint))) {
      return false;
    }
    const priorState = ownership.state;
    const now = this.now();
    const legacyChildAbsent = !currentHasListeners
      && Number.isInteger(ownership.detachedChildPid)
      && ownership.detachedChildPid > 0
      && stableProcessIdentity(ownership.detachedChildIdentity)
      && this.processLiveness(ownership.detachedChildPid) === false;
    const effectiveDecision = decision === 'missing'
      && !currentHasListeners
      && !legacyChildAbsent
      ? 'uncertain'
      : decision;
    const missingConfirmed = decision === 'missing'
      && effectiveDecision === 'missing'
      && Number.isFinite(ownership.detachedServiceMissingAt)
      && now >= ownership.detachedServiceMissingAt
      && now - ownership.detachedServiceMissingAt >= confirmationMs;
    const claimCleanup = effectiveDecision === 'replaced' || missingConfirmed;
    if (!claimCleanup
      && ['present', 'uncertain'].includes(effectiveDecision)
      && !Number.isFinite(ownership.detachedServiceMissingAt)) {
      return false;
    }
    const normalizedPortGeneration = claimCleanup
      ? normalizeDetachedPortGeneration(ownership, portGeneration)
      : undefined;
    if (claimCleanup && !normalizedPortGeneration) {
      return false;
    }
    const reclaimToken = claimCleanup ? crypto.randomUUID() : undefined;
    const updated = updateJsonRecord(
      ownershipPath,
      (current) => validOwnership(current, projectId)
        && current.detached === true
        && current.token === expectedToken
        && current.state === priorState
        && !['stopping', 'reclaiming'].includes(current.state)
        && current.detachedChildPid === ownership.detachedChildPid
        && current.detachedChildIdentity === ownership.detachedChildIdentity
        && detachedServiceListenersFingerprint(
          current,
          current.detachedServiceListeners
        ) === currentFingerprint
        && Object.prototype.hasOwnProperty.call(current, 'detachedServiceListeners')
          === currentHasListeners,
      (current) => {
        const { detachedServiceMissingAt, ...retained } = current;
        if (claimCleanup) {
          return {
            ...retained,
            state: 'reclaiming',
            detachedReclaimToken: reclaimToken,
            detachedPortGeneration: normalizedPortGeneration
          };
        }
        if (effectiveDecision === 'missing') {
          return {
            ...retained,
            detachedServiceMissingAt: Number.isFinite(current.detachedServiceMissingAt)
              ? current.detachedServiceMissingAt
              : now
          };
        }
        return retained;
      }
    );
    return updated && claimCleanup ? {
      token: expectedToken,
      reclaimToken,
      priorState,
      hasDetachedServiceListeners: currentHasListeners,
      detachedServiceListeners: expectedListeners,
      detachedServiceListenersFingerprint: currentFingerprint,
      servicesFingerprint: JSON.stringify(ownership.services),
      detachedChildPid: ownership.detachedChildPid,
      detachedChildIdentity: ownership.detachedChildIdentity,
      detachedPortGenerationFingerprint: JSON.stringify(normalizedPortGeneration),
      portGeneration: new Map(normalizedPortGeneration.map(({ port, token }) => [port, token]))
    } : false;
  }

  ownsDetachedServiceCleanupClaim(projectId, claim) {
    if (!claim
      || !stableProcessIdentity(claim.token)
      || !stableProcessIdentity(claim.reclaimToken)) {
      return false;
    }
    return updateJsonRecord(
      this.ownershipPath(projectId),
      (current) => detachedServiceCleanupClaimMatches(current, projectId, claim),
      (current) => current
    );
  }

  rollbackDetachedServiceCleanup(projectId, claim) {
    if (!claim
      || !stableProcessIdentity(claim.token)
      || !stableProcessIdentity(claim.reclaimToken)) {
      return false;
    }
    const ownershipPath = this.ownershipPath(projectId);
    return updateJsonRecord(
      ownershipPath,
      (current) => detachedServiceCleanupClaimMatches(current, projectId, claim),
      (current) => {
        const {
          detachedPortGeneration,
          detachedReclaimToken,
          ...retained
        } = current;
        return {
          ...retained,
          state: claim.priorState || 'detached'
        };
      }
    );
  }

  finishDetachedServiceCleanup(projectId, claim) {
    if (!claim
      || !stableProcessIdentity(claim.token)
      || !stableProcessIdentity(claim.reclaimToken)) {
      return false;
    }
    const ownershipPath = this.ownershipPath(projectId);
    const released = updateJsonRecord(
      ownershipPath,
      (current) => detachedServiceCleanupClaimMatches(current, projectId, claim)
    );
    if (!released) {
      return false;
    }
    updateJsonRecord(
      this.stopRequestPath(projectId),
      (request) => request?.token === claim.token
    );
    const local = this.owned.get(projectId);
    if (local?.token === claim.token) {
      this.owned.delete(projectId);
      this.pendingProcessIdentities.delete(projectId);
      this.consumedStopRequests.delete(projectId);
    }
    return true;
  }

  isCurrentOwner(projectId, options = {}) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const current = readJson(owned.ownershipPath);
    return current?.token === owned.token
      && current.hostPid === this.pid
      && this.hostIdentityMatches(current, { fresh: options.fresh === true });
  }

  currentOwnership(projectId) {
    const owned = this.owned.get(projectId);
    return owned ? readJson(owned.ownershipPath) : undefined;
  }

  owns(projectId, childPid) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const current = readJson(owned.ownershipPath);
    return current?.token === owned.token
      && current.hostPid === this.pid
      && current.childPid === childPid
      && this.hostIdentityMatches(current);
  }

  async terminateOwnedProcess(projectId, options = {}) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const current = readJson(owned.ownershipPath);
    if (current?.token !== owned.token
      || current.hostPid !== this.pid
      || !Number.isInteger(current.childPid)
      || current.childPid <= 0) {
      return false;
    }
    if (!this.hostIdentityMatches(current, { fresh: true })) {
      return false;
    }
    if (!this.isProcessAlive(current.childPid)) {
      return true;
    }

    const pendingIdentity = this.pendingProcessIdentities.get(projectId);
    const persistedIdentity = Object.prototype.hasOwnProperty.call(current, 'childIdentity')
      ? current.childIdentity
      : undefined;
    if (persistedIdentity !== undefined && !stableProcessIdentity(persistedIdentity)) {
      throw new Error('Runlist could not verify the launched process identity.');
    }
    const pendingValue = pendingIdentity?.childPid === current.childPid
      ? await pendingIdentity.promise
      : undefined;
    const expectedIdentity = persistedIdentity || pendingValue;
    if (current.identityRequired && !stableProcessIdentity(expectedIdentity)) {
      throw new Error('Runlist could not verify the launched process identity.');
    }
    if (expectedIdentity !== undefined && !stableProcessIdentity(expectedIdentity)) {
      throw new Error('Runlist could not verify the launched process identity.');
    }
    if (stableProcessIdentity(expectedIdentity)) {
      const identity = await (options.readProcessIdentity || this.readProcessIdentity)(
        current.childPid,
        this.platform
      );
      if (processIdentityDecision(
        expectedIdentity,
        identity,
        this.platform,
        current.childPid
      ) !== 'match') {
        throw new Error('Runlist did not stop the process because its process identity changed.');
      }
    }

    const latest = readJson(owned.ownershipPath);
    if (latest?.token !== owned.token
      || latest.hostPid !== this.pid
      || latest.childPid !== current.childPid
      || !this.hostIdentityMatches(latest, { fresh: true })) {
      throw new Error('Runlist did not stop the process because its launch ownership changed.');
    }

    try {
      await terminateProcessTree(current.childPid, {
        platform: this.platform,
        ...options,
        ...(stableProcessIdentity(expectedIdentity) ? {
          expectedIdentity,
          readProcessIdentity: options.readProcessIdentity || this.readProcessIdentity
        } : {})
      });
    } catch (error) {
      if (!this.isProcessAlive(current.childPid)) {
        return true;
      }
      throw error;
    }
    return true;
  }

  release(projectId) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const released = updateJsonRecord(
      owned.ownershipPath,
      (current) => current?.token === owned.token
        && current.hostPid === this.pid
        && this.hostIdentityMatches(current, { fresh: true })
    );
    if (!released) {
      return false;
    }
    updateJsonRecord(
      this.stopRequestPath(projectId),
      (request) => request?.token === owned.token
    );
    this.owned.delete(projectId);
    this.pendingProcessIdentities.delete(projectId);
    this.consumedStopRequests.delete(projectId);
    return true;
  }

  releaseShared(projectId, expectedToken) {
    if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
      return false;
    }
    const ownershipPath = this.ownershipPath(projectId);
    const ownership = readJson(ownershipPath);
    if (!validOwnership(ownership, projectId)
      || ownership.token !== expectedToken
      || ownership.detached !== true) {
      return false;
    }
    const released = updateJsonRecord(
      ownershipPath,
      (current) => validOwnership(current, projectId) && current.token === expectedToken
    );
    if (!released) {
      return false;
    }
    updateJsonRecord(
      this.stopRequestPath(projectId),
      (request) => request?.token === expectedToken
    );
    const local = this.owned.get(projectId);
    if (local?.token === expectedToken) {
      this.owned.delete(projectId);
      this.pendingProcessIdentities.delete(projectId);
      this.consumedStopRequests.delete(projectId);
    }
    return true;
  }

  async reconcileProcessIdentities() {
    const candidates = fs.readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .map((filename) => {
        const ownershipPath = path.join(this.directory, filename);
        return { ownershipPath, ownership: readJson(ownershipPath) };
      })
      .filter(({ ownership }) => validOwnership(ownership)
        && stableProcessIdentity(ownership.childIdentity)
        && Number.isInteger(ownership.childPid)
        && !this.ownerIsAvailable(ownership)
        && this.isProcessAlive(ownership.childPid));
    let removed = 0;
    for (const { ownershipPath, ownership } of candidates) {
      const identity = await Promise.resolve(this.readProcessIdentity(
        ownership.childPid,
        this.platform
      )).catch(() => undefined);
      if (processIdentityDecision(
        ownership.childIdentity,
        identity,
        ownership.platform || this.platform,
        ownership.childPid
      ) !== 'mismatch') {
        continue;
      }
      const removedCurrent = updateJsonRecord(
        ownershipPath,
        (current) => current?.token === ownership.token
          && current.childPid === ownership.childPid
          && current.childIdentity === ownership.childIdentity
          && !this.ownerIsAvailable(current)
      );
      if (removedCurrent) {
        updateJsonRecord(
          this.stopRequestPath(ownership.projectId),
          (request) => request?.token === ownership.token
        );
        removed += 1;
      }
    }
    return removed;
  }

  snapshot() {
    const projects = new Map();
    for (const filename of fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'))) {
      const ownershipPath = path.join(this.directory, filename);
      let ownership = readJson(ownershipPath);
      if (!validOwnership(ownership)) {
        removeInvalidJsonRecord(ownershipPath, this.invalidRecordGraceMs, this.now());
        continue;
      }
      const local = this.owned.get(ownership.projectId);
      if (local?.token === ownership.token
        && ownership.hostPid === this.pid
        && this.hostIdentityMatches(ownership)
        && this.now() - (ownership.heartbeatAt || 0) >= 1000) {
        updateJsonRecord(
          ownershipPath,
          (current) => current?.token === ownership.token
            && current.hostPid === this.pid
            && this.hostIdentityMatches(current),
          (current) => ({ ...current, heartbeatAt: this.now() })
        );
        ownership = readJson(ownershipPath);
      }
      if (!validOwnership(ownership)) {
        continue;
      }
      const hostDecision = this.hostIdentityDecision(ownership);
      const hostAlive = runtimeHostOwnerState(hostDecision, {
        heartbeatAt: ownership.heartbeatAt,
        heartbeatTimeoutMs: this.ownerHeartbeatTimeoutMs,
        now: this.now()
      }) === 'available';
      const childLiveness = this.childProcessLiveness(ownership);
      const processAlive = childLiveness === true;
      if (!ownership.detached
        && (hostDecision === 'mismatch'
          || (childLiveness === false && (hostDecision !== 'match' || !hostAlive)))) {
        const removed = updateJsonRecord(
          ownershipPath,
          (current) => this.canReclaimOwnership(
            current,
            ownership,
            hostDecision
          )
        );
        if (removed) {
          updateJsonRecord(
            this.stopRequestPath(ownership.projectId),
            (request) => request?.token === ownership.token
          );
          continue;
        }
      }
      const stopRequested = readJson(this.stopRequestPath(ownership.projectId))?.token === ownership.token;
      projects.set(ownership.projectId, {
        ...ownership,
        ownerAvailable: hostAlive,
        processActive: Boolean(processAlive),
        state: stopRequested ? 'stopping' : ownership.state
      });
    }
    return projects;
  }

  requestStop(projectId, expectedToken) {
    const ownership = readJson(this.ownershipPath(projectId));
    if (!validOwnership(ownership, projectId)) {
      return { kind: 'missing' };
    }
    if (expectedToken && ownership.token !== expectedToken) {
      return { kind: 'changed' };
    }
    if (ownership.hostPid === this.pid && this.owned.get(projectId)?.token === ownership.token) {
      return { kind: 'local' };
    }
    if (!this.ownerIsAvailable(ownership)) {
      return { kind: 'uncertain' };
    }

    const requestPath = this.stopRequestPath(projectId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(requestPath, JSON.stringify({
          projectId,
          requesterPid: this.pid,
          requestedAt: this.now(),
          token: ownership.token
        }), { flag: 'wx', mode: 0o600 });
        return { kind: 'requested' };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        const existingRequest = readJson(requestPath);
        if (existingRequest?.token === ownership.token) {
          return { kind: 'requested' };
        }
        if (existingRequest) {
          updateJsonRecord(
            requestPath,
            (request) => sameStopRequest(request, existingRequest)
          );
        } else {
          removeInvalidJsonRecord(requestPath, this.invalidRecordGraceMs, this.now());
        }
      }
    }
    return { kind: 'uncertain' };
  }

  cancelStopRequest(projectId) {
    const ownership = readJson(this.ownershipPath(projectId));
    const requestPath = this.stopRequestPath(projectId);
    const request = readJson(requestPath);
    if (request?.requesterPid !== this.pid || request?.token !== ownership?.token) {
      return false;
    }
    return updateJsonRecord(
      requestPath,
      (current) => sameStopRequest(current, request)
        && current.token === ownership.token
    );
  }

  consumeStopRequests() {
    const projectIds = [];
    for (const [projectId, owned] of this.owned) {
      const requestPath = this.stopRequestPath(projectId);
      const request = readJson(requestPath);
      if (request?.token === owned.token) {
        const requestKey = `${request.token}:${request.requesterPid}:${request.requestedAt}`;
        const ownership = readJson(owned.ownershipPath);
        if (ownership?.token !== owned.token
          || ownership.hostPid !== this.pid
          || !this.hostIdentityMatches(ownership, { fresh: true })) {
          this.consumedStopRequests.delete(projectId);
          if (this.stopRequestFailureKeys.get(projectId) !== requestKey) {
            this.stopRequestFailureKeys.set(projectId, requestKey);
            this.stopRequestFailures.set(
              projectId,
              'Runlist could not safely run the requested Stop command because the launching process identity could not be verified. The process was left running.'
            );
          }
          continue;
        }
        this.stopRequestFailureKeys.delete(projectId);
        this.stopRequestFailures.delete(projectId);
        if (this.consumedStopRequests.get(projectId) !== requestKey) {
          this.consumedStopRequests.set(projectId, requestKey);
          projectIds.push(projectId);
        }
      } else {
        this.consumedStopRequests.delete(projectId);
        this.stopRequestFailureKeys.delete(projectId);
        this.stopRequestFailures.delete(projectId);
      }
      if (request && request.token !== owned.token) {
        updateJsonRecord(
          requestPath,
          (current) => sameStopRequest(current, request)
        );
      }
    }
    return projectIds;
  }

  consumeStopRequestFailures() {
    const failures = [...this.stopRequestFailures]
      .map(([projectId, message]) => ({ projectId, message }));
    this.stopRequestFailures.clear();
    return failures;
  }

  completeStopRequest(projectId) {
    const owned = this.owned.get(projectId);
    const requestPath = this.stopRequestPath(projectId);
    const request = readJson(requestPath);
    if (!owned || request?.token !== owned.token) {
      this.consumedStopRequests.delete(projectId);
      return false;
    }
    if (!updateJsonRecord(
      requestPath,
      (current) => sameStopRequest(current, request)
        && current.token === owned.token
    )) {
      return false;
    }
    this.consumedStopRequests.delete(projectId);
    return true;
  }

  updateOwned(projectId, update, options = {}) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const updated = updateJsonRecord(
      owned.ownershipPath,
      (current) => current?.token === owned.token
        && this.hostIdentityMatches(current)
        && (options.allowDetached !== false || current.detached !== true),
      (current) => ({
        ...update(current),
        heartbeatAt: this.now()
      })
    );
    if (!updated) {
      this.owned.delete(projectId);
      return false;
    }
    return true;
  }

  ownerIsAvailable(ownership) {
    return runtimeHostOwnerState(this.hostIdentityDecision(ownership), {
      heartbeatAt: ownership?.heartbeatAt,
      heartbeatTimeoutMs: this.ownerHeartbeatTimeoutMs,
      now: this.now()
    }) === 'available';
  }

  hostIdentityMatches(ownership, options = {}) {
    return this.hostIdentityDecision(ownership, options) === 'match';
  }

  hostIdentityDecision(ownership, options = {}) {
    return runtimeProcessOwnerDecision({
      cache: this.hostIdentityCache,
      cacheTtlMs: this.hostIdentityCacheTtlMs,
      currentIdentity: this.hostIdentity,
      currentPid: this.pid,
      expectedIdentity: ownership?.hostIdentity,
      fresh: options.fresh === true,
      isProcessAlive: this.isProcessAlive,
      now: this.now,
      pid: ownership?.hostPid,
      platform: ownership?.platform || this.platform,
      readProcessIdentity: this.readHostProcessIdentity
    });
  }

  ownerHeartbeatExpired(ownership) {
    return Number.isFinite(ownership?.heartbeatAt)
      && this.now() - ownership.heartbeatAt > this.ownerHeartbeatTimeoutMs;
  }

  processLiveness(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    try {
      const alive = this.isProcessAlive(pid);
      return alive === true ? true : alive === false ? false : undefined;
    } catch {
      return undefined;
    }
  }

  childProcessLiveness(ownership) {
    if (!Object.prototype.hasOwnProperty.call(ownership || {}, 'childPid')) {
      return false;
    }
    return this.processLiveness(ownership.childPid);
  }

  canReclaimOwnership(current, expected, initialDecision) {
    if (!validOwnership(current, expected.projectId)
      || current.token !== expected.token
      || current.hostPid !== expected.hostPid
      || current.childPid !== expected.childPid) {
      return false;
    }
    const finalDecision = this.hostIdentityDecision(current, { fresh: true });
    if (finalDecision === 'mismatch') {
      return true;
    }
    if (finalDecision === 'absent') {
      return this.childProcessLiveness(current) === false;
    }
    if (finalDecision === 'match'
      && initialDecision === 'match'
      && this.ownerHeartbeatExpired(current)) {
      return this.childProcessLiveness(current) === false;
    }
    return false;
  }

  ownershipPath(projectId) {
    return path.join(this.directory, `${projectKey(projectId)}.json`);
  }

  stopRequestPath(projectId) {
    return path.join(this.directory, `${projectKey(projectId)}.stop`);
  }
}

function validOwnership(value, projectId) {
  return Boolean(value
    && typeof value.projectId === 'string'
    && (!projectId || value.projectId === projectId)
    && Number.isInteger(value.hostPid)
    && value.hostPid > 0
    && typeof value.token === 'string');
}

function validRuntimePortOverrides(value) {
  return Array.isArray(value)
    && value.length <= 32
    && value.every((override) => override
      && typeof override === 'object'
      && !Array.isArray(override)
      && typeof override.serviceName === 'string'
      && override.serviceName.length > 0
      && override.serviceName.length <= 64
      && Number.isInteger(override.savedPort)
      && override.savedPort >= 1
      && override.savedPort <= 65535
      && Number.isInteger(override.port)
      && override.port >= 1
      && override.port <= 65535
      && typeof override.variable === 'string'
      && override.variable.length > 0
      && override.variable.length <= 256);
}

function projectKey(projectId) {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex');
}

function sameStopRequest(left, right) {
  return Boolean(left && right
    && left.token === right.token
    && left.requesterPid === right.requesterPid
    && left.requestedAt === right.requestedAt);
}

async function promisedIdentity(value) {
  try {
    return await Promise.resolve(value);
  } catch {
    return undefined;
  }
}

function promisedIdentityWithin(value, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (identity) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(identity);
    };
    timer = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
    Promise.resolve(value).then(finish, () => finish(undefined));
  });
}

function lastUsefulLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function startExitDetached({ code, hasCustomStop, hasServices, stoppedIntentionally }) {
  return !stoppedIntentionally && code === 0 && hasServices && hasCustomStop;
}

function startExitFailed(details) {
  return !details.stoppedIntentionally
    && !startExitDetached(details)
    && (details.code !== 0 || details.hasServices);
}

module.exports = {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  detachedServiceIdentityDecision,
  handoffProjectSafely,
  markOwnedRuntimeDetached,
  ProcessOwnershipStore,
  projectStopStrategy,
  projectProcessSpawnOptions,
  spawnProjectCommand,
  readProcessIdentity,
  readProcessIdentitySync,
  recordStartedProcess,
  releaseSupervisorIdentityHold,
  restartProjectSafely,
  rollbackStartedProcess,
  shutdownTrackedProcesses,
  shouldRequestRemoteCustomStop,
  startExitDetached,
  startExitFailed,
  terminateProcessTree,
  terminateTrackedProcess,
  transitionOwnedRuntimeState
};
