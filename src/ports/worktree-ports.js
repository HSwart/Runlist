const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomically } = require('../projects/project-store');

const WORKTREE_PORT_BASE = 21000;
const WORKTREE_PORT_SPAN = 20000;
const MAX_ALLOCATION_ATTEMPTS = 64;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_RETRY_MS = 5;
const LOCK_STALE_MS = 2000;

class WorktreePortsError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'WorktreePortsError';
    this.code = code;
  }
}

function readWorktreePortLedger(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { schemaVersion: 1, entries: [] };
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { schemaVersion: 1, entries: [] };
    }
    if (!Array.isArray(value.entries)) {
      return { schemaVersion: 1, entries: [] };
    }
    return {
      schemaVersion: 1,
      entries: value.entries.filter((entry) => entry && typeof entry === 'object')
    };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

function writeWorktreePortLedger(filePath, ledger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomically(filePath, `${JSON.stringify({
    schemaVersion: 1,
    entries: Array.isArray(ledger?.entries) ? ledger.entries : []
  }, null, 2)}\n`);
}

function allocateWorktreePortOverrides(options = {}) {
  const {
    project,
    identity,
    ledgerFile,
    isPortFree = () => true
  } = options;
  if (!identity?.id || !project?.id || !ledgerFile) {
    return null;
  }
  const services = Array.isArray(project.services) ? project.services : [];
  if (!services.length) {
    return null;
  }
  if (services.some((service) => !String(service.portVariable || '').trim())) {
    return null;
  }

  return withLedgerLock(ledgerFile, () => {
    const ledger = readWorktreePortLedger(ledgerFile);
    const existing = ledger.entries.find((entry) => (
      entry.projectId === project.id && entry.worktreeId === identity.id
    ));
    if (existing?.overrides?.length) {
      const reusable = existing.overrides.map((override) => ({ ...override }));
      if (overridesMatchServices(reusable, services)
        && reusable.every((override) => isPortFree(override.port))) {
        return { overrides: reusable, reused: true };
      }
    }

    const reserved = reservedPorts(ledger, project.id, identity.id);
    let overrides;
    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const candidate = candidateOverrides(project, identity, attempt);
      if (!candidate) {
        break;
      }
      if (candidate.some((override) => reserved.has(override.port))) {
        continue;
      }
      if (!candidate.every((override) => isPortFree(override.port))) {
        continue;
      }
      overrides = candidate;
      break;
    }
    if (!overrides) {
      throw new WorktreePortsError(
        'ALLOCATION_FAILED',
        'Runlist could not reserve sticky worktree ports for this folder. Free some ports and try Start again.'
      );
    }

    const nextEntries = ledger.entries.filter((entry) => !(
      entry.projectId === project.id && entry.worktreeId === identity.id
    ));
    nextEntries.push({
      projectId: project.id,
      worktreeId: identity.id,
      worktreeRoot: identity.worktreeRoot,
      overrides,
      updatedAt: Date.now()
    });
    writeWorktreePortLedger(ledgerFile, { entries: nextEntries });
    return { overrides, reused: false };
  });
}

function withLedgerLock(filePath, operation) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  let fd;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      try {
        const age = Date.now() - Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).createdAt || 0);
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Retry.
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  if (fd === undefined) {
    throw new WorktreePortsError(
      'LEDGER_BUSY',
      'Runlist could not update worktree port reservations. Try Start again.'
    );
  }
  try {
    return operation();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close failures after the critical section.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore missing lock cleanup.
    }
  }
}

function candidateOverrides(project, identity, attempt) {
  const services = project.services || [];
  const digest = crypto
    .createHash('sha256')
    .update(`${project.id}:${identity.id}:${attempt}`)
    .digest();
  const base = WORKTREE_PORT_BASE
    + (digest.readUInt16BE(0) % WORKTREE_PORT_SPAN);
  const overrides = [];
  const used = new Set();
  for (let index = 0; index < services.length; index += 1) {
    const service = services[index];
    let port = base + index;
    while (port <= 65535 && (used.has(port) || port === service.port)) {
      port += services.length;
    }
    if (port > 65535) {
      return undefined;
    }
    used.add(port);
    overrides.push({
      serviceName: service.name,
      savedPort: service.port,
      port,
      variable: String(service.portVariable).trim()
    });
  }
  return overrides;
}

function overridesMatchServices(overrides, services) {
  if (overrides.length !== services.length) {
    return false;
  }
  return services.every((service) => {
    const override = overrides.find((entry) => entry.serviceName === service.name);
    return override
      && override.savedPort === service.port
      && override.variable === String(service.portVariable || '').trim();
  });
}

function reservedPorts(ledger, projectId, worktreeId) {
  const ports = new Set();
  for (const entry of ledger.entries || []) {
    if (entry.projectId === projectId && entry.worktreeId === worktreeId) {
      continue;
    }
    for (const override of entry.overrides || []) {
      if (Number.isInteger(override.port)) {
        ports.add(override.port);
      }
    }
  }
  return ports;
}

module.exports = {
  WorktreePortsError,
  allocateWorktreePortOverrides,
  readWorktreePortLedger,
  writeWorktreePortLedger
};
