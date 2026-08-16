const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function projectProcessSpawnOptions(platform = process.platform) {
  return platform === 'win32'
    ? { detached: false, windowsHide: true }
    : { detached: true };
}

function customStopSpawnOptions(platform = process.platform) {
  return {
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(platform === 'win32' ? { windowsHide: true } : {})
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

  processes.delete(id);
  try {
    await terminateProcessTree(child.pid, options);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
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
    await actions.start();
    return true;
  } finally {
    restartingProjectIds.delete(id);
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
  while (processGroupIsAlive(pid, kill)) {
    if (Date.now() >= termDeadline) {
      kill(-pid, 'SIGKILL');
      break;
    }
    await delay(options.pollIntervalMs ?? 100);
  }

  const killDeadline = Date.now() + (options.killTimeoutMs ?? 1000);
  while (processGroupIsAlive(pid, kill)) {
    if (Date.now() >= killDeadline) {
      throw new Error('the launched process tree did not exit after Runlist terminated it.');
    }
    await delay(options.pollIntervalMs ?? 100);
  }
}

function processGroupIsAlive(pid, kill) {
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
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
    this.owned = new Map();
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
        return { kind: 'uncertain' };
      }
      const hostAlive = this.isProcessAlive(existing.hostPid);
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
    this.updateOwned(projectId, (ownership) => ({
      ...ownership,
      childPid,
      ...(Number.isFinite(details.readinessDeadline)
        ? { readinessDeadline: details.readinessDeadline }
        : {}),
      state: details.state || 'running'
    }));
  }

  setState(projectId, state) {
    this.updateOwned(projectId, (ownership) => ({ ...ownership, state }));
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
    return true;
  }

  snapshot() {
    const projects = new Map();
    for (const filename of fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'))) {
      const ownershipPath = path.join(this.directory, filename);
      const ownership = readJson(ownershipPath);
      if (!validOwnership(ownership)) {
        continue;
      }
      const hostAlive = this.isProcessAlive(ownership.hostPid);
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

  requestStop(projectId) {
    const ownership = readJson(this.ownershipPath(projectId));
    if (!validOwnership(ownership, projectId)) {
      return { kind: 'missing' };
    }
    if (ownership.hostPid === this.pid && this.owned.get(projectId)?.token === ownership.token) {
      return { kind: 'local' };
    }
    if (!this.isProcessAlive(ownership.hostPid)) {
      return { kind: 'uncertain' };
    }

    const requestPath = this.stopRequestPath(projectId);
    try {
      fs.writeFileSync(requestPath, JSON.stringify({
        projectId,
        requesterPid: this.pid,
        requestedAt: Date.now(),
        token: ownership.token
      }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
    return { kind: 'requested' };
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
        projectIds.push(projectId);
      }
      if (request) {
        tryUnlink(requestPath);
      }
    }
    return projectIds;
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
    writeJsonAtomically(owned.ownershipPath, update(current));
    return true;
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

function projectKey(projectId) {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex');
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
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

function lastUsefulLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

module.exports = {
  cleanupTrackedProcessForDeletion,
  customStopSpawnOptions,
  ProcessOwnershipStore,
  projectProcessSpawnOptions,
  restartProjectSafely,
  terminateProcessTree,
  terminateTrackedProcess
};
