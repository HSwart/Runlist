const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    this.isProcessAlive = options.isProcessAlive || processIsAlive;
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
        continue;
      }
      if (!lock.projectId || !lock.pid || !this.isProcessAlive(lock.pid)) {
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
        fs.writeFileSync(lockPath, JSON.stringify({ ...lock, state }), { mode: 0o600 });
      }
    }
  }

  snapshot() {
    const projects = new Map();
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      if (!lock) {
        continue;
      }
      if (!lock.projectId || !lock.pid || !this.isProcessAlive(lock.pid)) {
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
    const token = crypto.randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: this.pid,
        projectId,
        state: 'starting',
        token
      }));
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        tryUnlink(lockPath);
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const owner = readLock(lockPath);
      return { port, projectId: owner?.projectId };
    }
    fs.closeSync(descriptor);
    this.locks.set(port, { projectId, token });
    return undefined;
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
      if (!lock || (lock.pid && this.isProcessAlive(lock.pid))) {
        continue;
      }
      tryUnlink(lockPath);
    }
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
