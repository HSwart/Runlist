function servicePorts(project) {
  return [...new Set((project?.services || [])
    .map((service) => service.port)
    .filter((port) => Number.isInteger(port)))];
}

function projectsUsingPort(projects, port, excludeProjectId) {
  return (projects || []).filter((project) => project.id !== excludeProjectId
    && servicePorts(project).includes(port));
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

  release(projectId) {
    for (const [port, lock] of this.locks) {
      if (lock.projectId === projectId) {
        this.releasePort(port);
      }
    }
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
      fs.writeFileSync(descriptor, JSON.stringify({ pid: this.pid, projectId, token }));
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
    for (const filename of fs.readdirSync(this.directory)) {
      if (!/^port-\d+\.lock$/.test(filename)) {
        continue;
      }
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      if (lock?.pid && this.isProcessAlive(lock.pid)) {
        continue;
      }
      tryUnlink(lockPath);
    }
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
  PortReservationStore,
  occupiedPortConflict,
  projectsUsingPort,
  releaseProjectPorts,
  reserveProjectPorts,
  servicePorts
};
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
