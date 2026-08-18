const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRootProcess } = require('./process-metrics');

const OWNER_HEARTBEAT_TIMEOUT_MS = 10000;
const INVALID_RECORD_GRACE_MS = 2000;

function servicePorts(project) {
  return [...new Set((project?.services || [])
    .map((service) => service.port)
    .filter((port) => Number.isInteger(port)))];
}

function projectsUsingPort(projects, port, excludeProjectId) {
  return (projects || []).filter((project) => project.id !== excludeProjectId
    && servicePorts(project).includes(port));
}

function occupiedPortsBelongToProject(openPorts, reservationConflicts, projectId) {
  return Array.isArray(openPorts) && openPorts.every((port) => reservationConflicts
    .some((conflict) => conflict.port === port && conflict.projectId === projectId));
}

function reserveProjectPorts(reservations, project) {
  const ports = servicePorts(project);
  for (const port of ports) {
    const projectId = reservations.get(port);
    if (projectId) {
      return { port, projectId };
    }
  }
  for (const port of ports) {
    reservations.set(port, project.id);
  }
  return undefined;
}

class PortReservationStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.pid = options.pid || process.pid;
    this.platform = options.platform || process.platform;
    this.isProcessAlive = options.isProcessAlive || processIsAlive;
    this.readProcessIdentity = options.readProcessIdentity || readProcessIdentity;
    this.now = options.now || Date.now;
    this.ownerHeartbeatTimeoutMs = options.ownerHeartbeatTimeoutMs ?? OWNER_HEARTBEAT_TIMEOUT_MS;
    this.invalidRecordGraceMs = options.invalidRecordGraceMs ?? INVALID_RECORD_GRACE_MS;
    this.locks = new Map();
    fs.mkdirSync(directory, { recursive: true });
    this.removeStaleLocks();
  }

  reserve(project) {
    const acquired = [];
    for (const port of servicePorts(project).sort((left, right) => left - right)) {
      const conflict = this.acquire(port, project.id);
      if (conflict) {
        for (const acquiredPort of acquired) {
          this.releasePort(acquiredPort);
        }
        return conflict;
      }
      acquired.push(port);
    }
    return undefined;
  }

  conflicts(project) {
    const conflicts = [];
    for (const port of servicePorts(project).sort((left, right) => left - right)) {
      const lockPath = this.lockPath(port);
      const lock = readLock(lockPath);
      if (!lock) {
        if (invalidRecordIsStale(lockPath, this.invalidRecordGraceMs, this.now())) {
          tryUnlink(lockPath);
        }
        continue;
      }
      if (!lock.projectId || !lock.pid || !this.lockOwnerIsAlive(lock)) {
        tryUnlink(lockPath);
        continue;
      }
      if (lock.projectId !== project.id) {
        conflicts.push({ port, projectId: lock.projectId });
      }
    }
    return conflicts;
  }

  release(projectId) {
    for (const [port, lock] of this.locks) {
      if (lock.projectId === projectId) {
        this.releasePort(port);
      }
    }
  }

  releaseShared(projectId) {
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      if (lock?.projectId === projectId) {
        tryUnlink(lockPath);
      }
    }
    for (const [port, lock] of this.locks) {
      if (lock.projectId === projectId) {
        this.locks.delete(port);
      }
    }
  }

  setState(projectId, state) {
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      if (lock?.projectId === projectId) {
        writeJsonAtomically(lockPath, { ...lock, heartbeatAt: this.now(), state });
      }
    }
  }

  capture(projectId) {
    return new Map([...this.locks]
      .filter(([, lock]) => lock.projectId === projectId)
      .map(([port, lock]) => [port, lock.token]));
  }

  setProcess(projectId, childPid, childIdentity, expectedGeneration) {
    let updated = 0;
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      const port = Number(filename.match(/\d+/)?.[0]);
      const expectedToken = expectedGeneration instanceof Map
        ? expectedGeneration.get(port)
        : this.locks.get(port)?.token;
      if (lock?.projectId === projectId && expectedToken && lock.token === expectedToken) {
        writeJsonAtomically(lockPath, {
          ...lock,
          heartbeatAt: this.now(),
          childPid,
          ...(typeof childIdentity === 'string' ? { childIdentity } : {})
        });
        updated += 1;
      }
    }
    return updated;
  }

  async reconcileProcessIdentities() {
    const candidates = this.lockFiles().map((filename) => {
      const lockPath = path.join(this.directory, filename);
      return { lockPath, lock: readLock(lockPath) };
    }).filter(({ lock }) => lock
      && typeof lock.childIdentity === 'string'
      && Number.isInteger(lock.childPid)
      && !this.hostOwnerIsAvailable(lock)
      && this.isProcessAlive(lock.childPid));
    const identities = new Map();
    let removed = 0;
    for (const { lockPath, lock } of candidates) {
      let identity = identities.get(lock.childPid);
      if (!identities.has(lock.childPid)) {
        identity = await Promise.resolve(this.readProcessIdentity(lock.childPid, this.platform))
          .catch(() => undefined);
        identities.set(lock.childPid, identity);
      }
      if (!identity || identity === lock.childIdentity) {
        continue;
      }
      const current = readLock(lockPath);
      if (current?.token === lock.token
        && current.childPid === lock.childPid
        && current.childIdentity === lock.childIdentity
        && !this.hostOwnerIsAvailable(current)) {
        tryUnlink(lockPath);
        removed += 1;
      }
    }
    return removed;
  }

  snapshot() {
    const projects = new Map();
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      let lock = readLock(lockPath);
      if (!lock) {
        if (invalidRecordIsStale(lockPath, this.invalidRecordGraceMs, this.now())) {
          tryUnlink(lockPath);
        }
        continue;
      }
      const local = this.locks.get(Number(filename.match(/\d+/)?.[0]));
      if (local?.token === lock.token
        && this.now() - (lock.heartbeatAt || 0) >= 1000) {
        const updated = { ...lock, heartbeatAt: this.now() };
        writeJsonAtomically(lockPath, updated);
        lock = updated;
      }
      if (!lock.projectId || !lock.pid || !this.lockOwnerIsAlive(lock)) {
        tryUnlink(lockPath);
        continue;
      }
      projects.set(lock.projectId, lock.state || 'running');
    }
    return projects;
  }

  dispose() {
    for (const port of [...this.locks.keys()]) {
      this.releasePort(port);
    }
  }

  acquire(port, projectId) {
    const lockPath = this.lockPath(port);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = crypto.randomUUID();
      let descriptor;
      try {
        descriptor = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(descriptor, JSON.stringify({
          pid: this.pid,
          projectId,
          state: 'starting',
          heartbeatAt: this.now(),
          token
        }));
        fs.closeSync(descriptor);
        this.locks.set(port, { projectId, token });
        return undefined;
      } catch (error) {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
          tryUnlink(lockPath);
        }
        if (error.code !== 'EEXIST') {
          throw error;
        }
        const owner = readLock(lockPath);
        if (!owner && invalidRecordIsStale(lockPath, this.invalidRecordGraceMs, this.now())) {
          tryUnlink(lockPath);
          continue;
        }
        return { port, projectId: owner?.projectId };
      }
    }
    return { port, projectId: undefined };
  }

  releasePort(port) {
    const owned = this.locks.get(port);
    if (!owned) {
      return;
    }
    const current = readLock(this.lockPath(port));
    if (current?.token === owned.token) {
      tryUnlink(this.lockPath(port));
    }
    this.locks.delete(port);
  }

  removeStaleLocks() {
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      if (!lock) {
        if (invalidRecordIsStale(lockPath, this.invalidRecordGraceMs, this.now())) {
          tryUnlink(lockPath);
        }
        continue;
      }
      if (lock.pid && this.lockOwnerIsAlive(lock)) {
        continue;
      }
      tryUnlink(lockPath);
    }
  }

  lockOwnerIsAlive(lock) {
    return Boolean(this.hostOwnerIsAvailable(lock)
      || (lock.childPid && this.isProcessAlive(lock.childPid)));
  }

  hostOwnerIsAvailable(lock) {
    const heartbeatCurrent = !Number.isFinite(lock.heartbeatAt)
      || this.now() - lock.heartbeatAt <= this.ownerHeartbeatTimeoutMs;
    return Boolean(lock.pid && heartbeatCurrent && this.isProcessAlive(lock.pid));
  }

  lockFiles() {
    return fs.readdirSync(this.directory).filter((filename) => /^port-\d+\.lock$/.test(filename));
  }

  lockPath(port) {
    return path.join(this.directory, `port-${port}.lock`);
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
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

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function tryUnlink(lockPath) {
  try {
    fs.unlinkSync(lockPath);
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

async function readProcessIdentity(pid, platform) {
  return (await readRootProcess(pid, platform))?.identity;
}

function releaseProjectPorts(reservations, projectId) {
  for (const [port, ownerId] of reservations) {
    if (ownerId === projectId) {
      reservations.delete(port);
    }
  }
}

function occupiedPortConflict({ project, projects, managedProjectIds, openPorts }) {
  if (managedProjectIds.has(project.id)) {
    return undefined;
  }
  const occupiedPorts = servicePorts(project).filter((port) => openPorts.includes(port));
  for (const port of occupiedPorts) {
    const owner = projectsUsingPort(projects, port, project.id)
      .find((candidate) => managedProjectIds.has(candidate.id));
    if (owner) {
      return { kind: 'managed', owner, port };
    }
  }
  for (const port of occupiedPorts) {
    const sharedWith = projectsUsingPort(projects, port, project.id);
    if (sharedWith.length) {
      return { kind: 'ambiguous', port, sharedWith };
    }
  }
  return occupiedPorts.length
    ? { kind: 'occupied', port: occupiedPorts[0] }
    : undefined;
}

module.exports = {
  occupiedPortsBelongToProject,
  PortReservationStore,
  occupiedPortConflict,
  projectsUsingPort,
  releaseProjectPorts,
  reserveProjectPorts,
  servicePorts
};
