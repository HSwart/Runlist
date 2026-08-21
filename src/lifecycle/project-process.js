const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveLaunchProfile } = require('../projects/launch-profile');
const { execFile, spawn } = require('child_process');
const { readRootProcess } = require('./process-metrics');
const { writeFileAtomically } = require('../projects/project-store');
const { projectWithPortOverrides } = require('../ports/service-port-overrides');

const OWNER_HEARTBEAT_TIMEOUT_MS = 10000;
const INVALID_RECORD_GRACE_MS = 2000;

function projectProcessSpawnOptions(platform = process.platform) {
  return platform === 'win32'
    ? { detached: false, windowsHide: true }
    : { detached: true };
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

  const readIdentity = options.readProcessIdentity || readProcessIdentity;
  const identityRequired = Object.prototype.hasOwnProperty.call(child, 'runlistIdentity');
  const expectedIdentity = await promisedIdentity(child.runlistIdentity);
  if (identityRequired
    && !expectedIdentity
    && child.exitCode == null
    && child.signalCode == null) {
    throw new Error('Runlist could not verify the launched process identity.');
  }
  if (expectedIdentity) {
    const currentIdentity = await readIdentity(child.pid, options.platform || process.platform);
    if (currentIdentity && currentIdentity !== expectedIdentity) {
      throw new Error('Runlist did not stop the process because its process identity changed.');
    }
    if (!currentIdentity && child.exitCode === null && child.signalCode === null) {
      const isAlive = options.isProcessAlive || processIsAlive;
      if (options.allowMissing && !isAlive(child.pid)) {
        processes.delete(id);
        return true;
      }
      throw new Error('Runlist could not verify the launched process identity.');
    }
  }

  processes.delete(id);
  try {
    await terminateProcessTree(child.pid, options);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (expectedIdentity) {
        const currentIdentity = await readIdentity(child.pid, options.platform || process.platform);
        if (!currentIdentity) {
          return true;
        }
      }
      if (error.code === 'EPERM') {
        return true;
      }
    } else {
      processes.set(id, child);
    }
    throw error;
  }
  return true;
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

function shouldRequestRemoteCustomStop(project, ownership, hasLocalProcess, locallyOwnedWithoutHandle) {
  return Boolean(project?.stopCommand
    && ownership?.ownerAvailable
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

function recordStartedProcess(processOwnership, portReservations, project, child, details = {}) {
  const identity = processOwnership.trackProcessIdentity(project.id, child.pid);
  child.runlistIdentity = identity;
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
  return identity;
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
      kill(-pid, 'SIGKILL');
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
        return (await readGroup(pid, options)).length > 0;
      } catch {
        // Preserve the original permission failure when the fallback cannot prove the group is empty.
      }
    }
    throw error;
  }
}

function readPosixProcessGroup(processGroupId, options = {}) {
  const runFile = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    runFile('ps', ['-o', 'pid=', '-g', String(processGroupId)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 64 * 1024,
      timeout: options.processGroupProbeTimeoutMs ?? 1000,
      windowsHide: true
    }, (error, stdout) => {
      const pids = String(stdout || '').split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      if (!error || (Number(error.code) === 1 && pids.length === 0)) {
        resolve(pids);
        return;
      }
      reject(error);
    });
  });
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
    this.now = options.now || Date.now;
    this.ownerHeartbeatTimeoutMs = options.ownerHeartbeatTimeoutMs ?? OWNER_HEARTBEAT_TIMEOUT_MS;
    this.invalidRecordGraceMs = options.invalidRecordGraceMs ?? INVALID_RECORD_GRACE_MS;
    this.owned = new Map();
    this.pendingProcessIdentities = new Map();
    this.consumedStopRequests = new Map();
    fs.mkdirSync(directory, { recursive: true });
  }

  reserve(projectId) {
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
          token
        };
        fs.writeFileSync(descriptor, JSON.stringify(ownership));
        fs.closeSync(descriptor);
        this.owned.set(projectId, { ownershipPath, token });
        tryUnlink(this.stopRequestPath(projectId));
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
        if (invalidRecordIsStale(ownershipPath, this.invalidRecordGraceMs, this.now())) {
          tryUnlink(ownershipPath);
          continue;
        }
        return { kind: 'uncertain' };
      }
      const hostAlive = this.ownerIsAvailable(existing);
      const processAlive = existing.childPid && this.isProcessAlive(existing.childPid);
      if (hostAlive || processAlive) {
        return {
          kind: hostAlive ? 'owned' : 'uncertain',
          ownership: existing
        };
      }
      tryUnlink(ownershipPath);
      tryUnlink(this.stopRequestPath(projectId));
    }
    return { kind: 'uncertain' };
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
      ...(validRuntimePortOverrides(details.portOverrides)
        ? { portOverrides: details.portOverrides.map((override) => ({ ...override })) }
        : {}),
      ...(typeof details.childIdentity === 'string'
        ? { childIdentity: details.childIdentity }
        : {}),
      ...(details.identityRequired === true
        ? { identityRequired: true }
        : {}),
      state: details.state || 'running'
    }));
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
    if (identity && this.owns(projectId, childPid)) {
      try {
        this.updateOwned(projectId, (ownership) => ({
          ...ownership,
          childIdentity: identity
        }));
      } catch {
        return identity;
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

  owns(projectId, childPid) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const current = readJson(owned.ownershipPath);
    return current?.token === owned.token
      && current.hostPid === this.pid
      && current.childPid === childPid;
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
    if (!this.isProcessAlive(current.childPid)) {
      return true;
    }

    const pendingIdentity = this.pendingProcessIdentities.get(projectId);
    const expectedIdentity = current.childIdentity
      || (pendingIdentity?.childPid === current.childPid
        ? await pendingIdentity.promise
        : undefined);
    if (current.identityRequired && !expectedIdentity) {
      throw new Error('Runlist could not verify the launched process identity.');
    }
    if (expectedIdentity) {
      const identity = await (options.readProcessIdentity || this.readProcessIdentity)(
        current.childPid,
        this.platform
      );
      if (identity !== expectedIdentity) {
        throw new Error('Runlist did not stop the process because its process identity changed.');
      }
    }

    try {
      await terminateProcessTree(current.childPid, {
        platform: this.platform,
        ...options
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
    const current = readJson(owned.ownershipPath);
    if (current?.token === owned.token) {
      tryUnlink(owned.ownershipPath);
      tryUnlink(this.stopRequestPath(projectId));
    }
    this.owned.delete(projectId);
    this.pendingProcessIdentities.delete(projectId);
    this.consumedStopRequests.delete(projectId);
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
        && typeof ownership.childIdentity === 'string'
        && Number.isInteger(ownership.childPid)
        && !this.ownerIsAvailable(ownership)
        && this.isProcessAlive(ownership.childPid));
    let removed = 0;
    for (const { ownershipPath, ownership } of candidates) {
      const identity = await Promise.resolve(this.readProcessIdentity(
        ownership.childPid,
        this.platform
      )).catch(() => undefined);
      if (!identity || identity === ownership.childIdentity) {
        continue;
      }
      const current = readJson(ownershipPath);
      if (current?.token === ownership.token
        && current.childPid === ownership.childPid
        && current.childIdentity === ownership.childIdentity
        && !this.ownerIsAvailable(current)) {
        tryUnlink(ownershipPath);
        tryUnlink(this.stopRequestPath(ownership.projectId));
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
        if (invalidRecordIsStale(ownershipPath, this.invalidRecordGraceMs, this.now())) {
          tryUnlink(ownershipPath);
        }
        continue;
      }
      const local = this.owned.get(ownership.projectId);
      if (local?.token === ownership.token
        && this.now() - (ownership.heartbeatAt || 0) >= 1000) {
        const updated = { ...ownership, heartbeatAt: this.now() };
        writeJsonAtomically(ownershipPath, updated);
        ownership = updated;
      }
      const hostAlive = this.ownerIsAvailable(ownership);
      const processAlive = ownership.childPid && this.isProcessAlive(ownership.childPid);
      if (!hostAlive && !processAlive) {
        tryUnlink(ownershipPath);
        tryUnlink(this.stopRequestPath(ownership.projectId));
        continue;
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
        tryUnlink(requestPath);
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
    tryUnlink(requestPath);
    return true;
  }

  consumeStopRequests() {
    const projectIds = [];
    for (const [projectId, owned] of this.owned) {
      const requestPath = this.stopRequestPath(projectId);
      const request = readJson(requestPath);
      if (request?.token === owned.token) {
        const requestKey = `${request.token}:${request.requesterPid}:${request.requestedAt}`;
        if (this.consumedStopRequests.get(projectId) !== requestKey) {
          this.consumedStopRequests.set(projectId, requestKey);
          projectIds.push(projectId);
        }
      } else {
        this.consumedStopRequests.delete(projectId);
      }
      if (request && request.token !== owned.token) {
        tryUnlink(requestPath);
      }
    }
    return projectIds;
  }

  completeStopRequest(projectId) {
    const owned = this.owned.get(projectId);
    const requestPath = this.stopRequestPath(projectId);
    const request = readJson(requestPath);
    if (!owned || request?.token !== owned.token) {
      this.consumedStopRequests.delete(projectId);
      return false;
    }
    tryUnlink(requestPath);
    this.consumedStopRequests.delete(projectId);
    return true;
  }

  updateOwned(projectId, update) {
    const owned = this.owned.get(projectId);
    if (!owned) {
      return false;
    }
    const current = readJson(owned.ownershipPath);
    if (current?.token !== owned.token) {
      this.owned.delete(projectId);
      return false;
    }
    writeJsonAtomically(owned.ownershipPath, {
      ...update(current),
      heartbeatAt: this.now()
    });
    return true;
  }

  ownerIsAvailable(ownership) {
    const heartbeatCurrent = !Number.isFinite(ownership.heartbeatAt)
      || this.now() - ownership.heartbeatAt <= this.ownerHeartbeatTimeoutMs;
    return heartbeatCurrent && this.isProcessAlive(ownership.hostPid);
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

function writeJsonAtomically(filePath, value) {
  writeFileAtomically(filePath, JSON.stringify(value));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function invalidRecordIsStale(filePath, graceMs, now) {
  try {
    return now - fs.statSync(filePath).mtimeMs >= graceMs;
  } catch {
    return false;
  }
}

function tryUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
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

async function readProcessIdentity(pid, platform = process.platform) {
  try {
    return (await readRootProcess(pid, platform))?.identity;
  } catch {
    return undefined;
  }
}

async function promisedIdentity(value) {
  try {
    return await Promise.resolve(value);
  } catch {
    return undefined;
  }
}

function lastUsefulLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function startExitFailed({ code, hasServices, stoppedIntentionally }) {
  return !stoppedIntentionally && (code !== 0 || hasServices);
}

module.exports = {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  handoffProjectSafely,
  ProcessOwnershipStore,
  projectStopStrategy,
  projectProcessSpawnOptions,
  recordStartedProcess,
  restartProjectSafely,
  rollbackStartedProcess,
  shutdownTrackedProcesses,
  shouldRequestRemoteCustomStop,
  startExitFailed,
  terminateProcessTree,
  terminateTrackedProcess
};
