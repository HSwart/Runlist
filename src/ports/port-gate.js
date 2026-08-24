const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  currentProcessIdentity,
  processIdentityMismatch,
  readProcessIdentity,
  readProcessIdentitySync,
  stableProcessIdentity
} = require('../lifecycle/process-identity');
const {
  runtimeHostOwnerState,
  runtimeProcessOwnerDecision
} = require('../lifecycle/runtime-process-owner');
const {
  createAtomicJsonRecordUpdater,
  processIsAlive,
  readJsonRecord: readLock,
  tryUnlink
} = require('../lifecycle/atomic-json-record');
const { withExclusiveJsonLock } = require('../lifecycle/exclusive-json-lock');
const { writeFileAtomically } = require('../projects/project-store');

const OWNER_HEARTBEAT_TIMEOUT_MS = 10000;
const INVALID_RECORD_GRACE_MS = 2000;
const LOCK_UPDATE_MAX_ATTEMPTS = 200;
const LOCK_UPDATE_RETRY_MS = 5;
const LOCK_UPDATE_WAIT = new Int32Array(new SharedArrayBuffer(4));
const CURRENT_PROCESS_IDENTITY = currentProcessIdentity({ allowRuntimeFallback: true });
const PORT_RECORDS = createAtomicJsonRecordUpdater({
  errorMessage: 'Runlist could not safely update a shared port reservation.',
  invalidRecordGraceMs: INVALID_RECORD_GRACE_MS,
  processIdentity: CURRENT_PROCESS_IDENTITY,
  writeFileAtomically
});
const removeInvalidLock = PORT_RECORDS.removeInvalid;
const transientLockIsAbandoned = PORT_RECORDS.transientRecordIsAbandoned;
const updateLock = PORT_RECORDS.update;

function servicePorts(project) {
  return [...new Set((project?.services || [])
    .map((service) => service.port)
    .filter((port) => Number.isInteger(port)))];
}

function attachCleanupErrors(error, cleanupErrors) {
  if (cleanupErrors.length === 0
    || !error
    || (typeof error !== 'object' && typeof error !== 'function')) {
    return;
  }
  error.cleanupErrors = [
    ...(Array.isArray(error.cleanupErrors) ? error.cleanupErrors : []),
    ...cleanupErrors
  ];
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
    this.readHostProcessIdentity = options.readHostProcessIdentity
      || options.readProcessIdentitySync
      || ((pid, platform) => readProcessIdentitySync(pid, platform, options));
    this.now = options.now || Date.now;
    this.ownerHeartbeatTimeoutMs = options.ownerHeartbeatTimeoutMs ?? OWNER_HEARTBEAT_TIMEOUT_MS;
    this.invalidRecordGraceMs = options.invalidRecordGraceMs ?? INVALID_RECORD_GRACE_MS;
    this.locks = new Map();
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
    this.withReservationTransaction(() => this.removeStaleLocks());
  }

  reserve(project) {
    return this.withReservationTransaction(() => this.reserveUnlocked(project));
  }

  reserveUnlocked(project) {
    const acquired = [];
    const ports = servicePorts(project);
    if (ports.length > 0 && !stableProcessIdentity(this.hostIdentity)) {
      this.diagnose('reservation.blocked', {
        projectId: project?.id,
        reasonCode: 'host-identity-unavailable',
        identityDecision: 'unavailable',
        serviceCount: ports.length
      });
      throw new Error('Runlist could not verify the port reservation host identity.');
    }
    try {
      for (const port of ports.sort((left, right) => left - right)) {
        const conflict = this.acquire(port, project.id);
        if (conflict) {
          for (const acquiredPort of acquired) {
            this.releasePort(acquiredPort);
          }
          this.diagnose('reservation.blocked', {
            projectId: project?.id,
            reasonCode: 'reserved-by-project',
            serviceCount: ports.length
          });
          return conflict;
        }
        acquired.push(port);
      }
      if (ports.length > 0) {
        this.diagnose('reservation.acquired', {
          projectId: project?.id,
          reasonCode: 'ports-reserved',
          serviceCount: ports.length
        });
      }
      return undefined;
    } catch (error) {
      const cleanupErrors = [];
      for (const acquiredPort of acquired) {
        try {
          this.releasePort(acquiredPort);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      attachCleanupErrors(error, cleanupErrors);
      throw error;
    }
  }

  conflicts(project) {
    return this.withReservationTransaction(() => this.conflictsUnlocked(project));
  }

  conflictsUnlocked(project) {
    const conflicts = [];
    const identityCache = new Map();
    for (const port of servicePorts(project).sort((left, right) => left - right)) {
      const lockPath = this.lockPath(port);
      const lock = readLock(lockPath);
      if (!lock) {
        removeInvalidLock(lockPath, this.invalidRecordGraceMs, this.now());
        continue;
      }
      if (!lock.projectId
        || !lock.pid
        || (!lock.detached && this.lockOwnerState(lock, identityCache) === 'absent')) {
        updateLock(
          lockPath,
          (current) => current?.token === lock.token
            && (!current.projectId
              || !current.pid
              || (!current.detached && this.lockOwnerState(current) === 'absent'))
        );
        continue;
      }
      if (lock.projectId !== project.id) {
        conflicts.push({ port, projectId: lock.projectId });
      }
    }
    return conflicts;
  }

  release(projectId) {
    return this.withReservationTransaction(() => this.releaseUnlocked(projectId));
  }

  releaseUnlocked(projectId) {
    for (const [port, lock] of this.locks) {
      if (lock.projectId === projectId) {
        this.releasePort(port);
      }
    }
  }

  releaseShared(projectId, expectedGeneration) {
    return this.withReservationTransaction(() => this.releaseSharedUnlocked(projectId, expectedGeneration));
  }

  releaseSharedUnlocked(projectId, expectedGeneration) {
    if (!(expectedGeneration instanceof Map) || expectedGeneration.size === 0) {
      return false;
    }
    let released = false;
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      const port = Number(filename.match(/\d+/)?.[0]);
      const expectedToken = expectedGeneration.get(port);
      if (lock?.projectId === projectId
        && typeof expectedToken === 'string'
        && lock.token === expectedToken) {
        released = updateLock(lockPath, (current) => current?.token === lock.token) || released;
      }
    }
    for (const [port, lock] of this.locks) {
      const expectedToken = expectedGeneration.get(port);
      if (lock.projectId === projectId
        && typeof expectedToken === 'string'
        && lock.token === expectedToken) {
        this.locks.delete(port);
      }
    }
    return released;
  }

  markDetached(projectId) {
    return this.withReservationTransaction(() => {
      let marked = false;
      for (const filename of this.lockFiles()) {
        const lockPath = path.join(this.directory, filename);
        const lock = readLock(lockPath);
        if (lock?.projectId !== projectId) {
          continue;
        }
        if (updateLock(
          lockPath,
          (current) => current?.token === lock.token && current.projectId === projectId,
          (current) => {
            const { childIdentity, childPid, ...launch } = current;
            return {
              ...launch,
              detached: true,
              state: 'detached',
              heartbeatAt: this.now()
            };
          }
        )) {
          marked = true;
        }
      }
      return marked;
    });
  }

  setState(projectId, state) {
    let updated = false;
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      const port = Number(filename.match(/\d+/)?.[0]);
      const local = this.locks.get(port);
      if (lock?.projectId === projectId
        && local?.projectId === projectId
        && local.token === lock.token
        && lock.pid === this.pid
        && lock.hostIdentity === this.hostIdentity
        && this.hostIdentityDecision(lock) === 'match') {
        updated = updateLock(
          lockPath,
          (current) => current?.token === local.token
            && current.projectId === projectId
            && current.pid === this.pid
            && current.hostIdentity === this.hostIdentity
            && this.hostIdentityDecision(current) === 'match',
          (current) => ({ ...current, heartbeatAt: this.now(), state })
        ) || updated;
      }
    }
    return updated;
  }

  setStateShared(projectId, state, expectedGeneration) {
    if (!(expectedGeneration instanceof Map) || expectedGeneration.size === 0) {
      return false;
    }
    let updated = false;
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      const port = Number(filename.match(/\d+/)?.[0]);
      const expectedToken = expectedGeneration.get(port);
      if (lock?.projectId === projectId
        && typeof expectedToken === 'string'
        && lock.token === expectedToken) {
        updated = updateLock(
          lockPath,
          (current) => current?.projectId === projectId && current.token === expectedToken,
          (current) => ({ ...current, heartbeatAt: this.now(), state })
        ) || updated;
      }
    }
    return updated;
  }

  capture(projectId) {
    return new Map([...this.locks]
      .filter(([, lock]) => lock.projectId === projectId)
      .map(([port, lock]) => [port, lock.token]));
  }

  captureShared(projectId) {
    return this.withReservationTransaction(() => new Map(
      this.lockFiles()
        .map((filename) => {
          const lock = readLock(path.join(this.directory, filename));
          const port = Number(filename.match(/\d+/)?.[0]);
          return lock?.projectId === projectId && typeof lock.token === 'string'
            ? [port, lock.token]
            : undefined;
        })
        .filter(Boolean)
    ));
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
      if (lock?.projectId === projectId
        && !lock.detached
        && expectedToken
        && lock.token === expectedToken) {
        if (updateLock(
          lockPath,
          (current) => current?.token === expectedToken && current.projectId === projectId,
          (current) => ({
            ...current,
            heartbeatAt: this.now(),
            childPid,
            ...(typeof childIdentity === 'string' ? { childIdentity } : {})
          })
        )) {
          updated += 1;
        }
      }
    }
    return updated;
  }

  async reconcileProcessIdentities() {
    const identityCache = new Map();
    const candidates = this.lockFiles().map((filename) => {
      const lockPath = path.join(this.directory, filename);
      return { lockPath, lock: readLock(lockPath) };
    }).filter(({ lock }) => lock
      && typeof lock.childIdentity === 'string'
      && Number.isInteger(lock.childPid)
      && this.hostOwnerState(lock, identityCache) === 'absent'
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
      if (!processIdentityMismatch(
        lock.childIdentity,
        identity,
        this.platform,
        lock.childPid
      )) {
        continue;
      }
      const current = readLock(lockPath);
      if (current?.token === lock.token
        && current.childPid === lock.childPid
        && current.childIdentity === lock.childIdentity
        && this.hostOwnerState(current) === 'absent') {
        if (updateLock(
          lockPath,
          (latest) => latest?.token === lock.token
            && latest.childPid === lock.childPid
            && latest.childIdentity === lock.childIdentity
            && this.hostOwnerState(latest) === 'absent'
        )) {
          removed += 1;
        }
      }
    }
    return removed;
  }

  snapshot() {
    return this.withReservationTransaction(() => this.snapshotUnlocked());
  }

  snapshotUnlocked() {
    const projects = new Map();
    const identityCache = new Map();
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      let lock = readLock(lockPath);
      if (!lock) {
        removeInvalidLock(lockPath, this.invalidRecordGraceMs, this.now());
        continue;
      }
      const local = this.locks.get(Number(filename.match(/\d+/)?.[0]));
      if (local?.token === lock.token
        && lock.pid === this.pid
        && this.hostIdentityDecision(lock) === 'match'
        && this.now() - (lock.heartbeatAt || 0) >= 1000) {
        updateLock(
          lockPath,
          (current) => current?.token === lock.token
            && current.pid === this.pid
            && current.hostIdentity === this.hostIdentity
            && this.hostIdentityDecision(current) === 'match',
          (current) => ({ ...current, heartbeatAt: this.now() })
        );
        lock = readLock(lockPath);
      }
      if (!lock) {
        continue;
      }
      if (!lock.projectId
        || !lock.pid
        || (!lock.detached && this.lockOwnerState(lock, identityCache) === 'absent')) {
        updateLock(
          lockPath,
          (current) => current?.token === lock.token
            && (!current.projectId
              || !current.pid
              || (!current.detached && this.lockOwnerState(current) === 'absent'))
        );
        continue;
      }
      projects.set(lock.projectId, lock.state || 'running');
    }
    return projects;
  }

  dispose() {
    this.withReservationTransaction(() => {
      for (const port of [...this.locks.keys()]) {
        this.releasePort(port);
      }
    });
  }

  acquire(port, projectId) {
    const lockPath = this.lockPath(port);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = crypto.randomUUID();
      let descriptor;
      let created = false;
      try {
        descriptor = fs.openSync(lockPath, 'wx');
        created = true;
        fs.writeFileSync(descriptor, JSON.stringify({
          pid: this.pid,
          hostIdentity: this.hostIdentity,
          platform: this.platform,
          projectId,
          state: 'starting',
          heartbeatAt: this.now(),
          token
        }));
        try {
          fs.closeSync(descriptor);
        } finally {
          descriptor = undefined;
        }
        this.locks.set(port, { projectId, token });
        return undefined;
      } catch (error) {
        const cleanupErrors = [];
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          } finally {
            descriptor = undefined;
          }
        }
        if (created) {
          const current = readLock(lockPath);
          if (current?.token === token) {
            try {
              updateLock(lockPath, (latest) => latest?.token === token);
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          } else if (!current) {
            try {
              tryUnlink(lockPath);
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }
        }
        if (this.locks.get(port)?.token === token) {
          this.locks.delete(port);
        }
        attachCleanupErrors(error, cleanupErrors);
        if (error.code !== 'EEXIST') {
          throw error;
        }
        const owner = readLock(lockPath);
        if (!owner && removeInvalidLock(lockPath, this.invalidRecordGraceMs, this.now())) {
          this.diagnose('reservation.stale-recovered', {
            projectId,
            reasonCode: 'invalid-record',
            identityDecision: 'unavailable'
          });
          continue;
        }
        if (owner && !owner.detached
          && (!owner.projectId || !owner.pid || this.lockOwnerState(owner) === 'absent')) {
          const removed = updateLock(
            lockPath,
              (current) => current?.token === owner.token
              && (!current.projectId
                || !current.pid
                || (!current.detached && this.lockOwnerState(current) === 'absent'))
          );
          if (removed) {
            this.diagnose('reservation.stale-recovered', {
              projectId,
              reasonCode: 'owner-absent',
              identityDecision: owner ? this.hostIdentityDecision(owner) : 'unavailable'
            });
            continue;
          }
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
    if (current?.token === owned.token
      && current.pid === this.pid
      && current.hostIdentity === this.hostIdentity
      && this.hostIdentityDecision(current) === 'match') {
      updateLock(
        this.lockPath(port),
        (latest) => latest?.token === owned.token
          && latest.pid === this.pid
          && latest.hostIdentity === this.hostIdentity
          && this.hostIdentityDecision(latest) === 'match'
      );
    }
    this.locks.delete(port);
  }

  removeStaleLocks() {
    const identityCache = new Map();
    for (const filename of this.lockFiles()) {
      const lockPath = path.join(this.directory, filename);
      const lock = readLock(lockPath);
      if (!lock) {
        removeInvalidLock(lockPath, this.invalidRecordGraceMs, this.now());
        continue;
      }
      if (lock.detached
        || (lock.pid && this.lockOwnerState(lock, identityCache) !== 'absent')) {
        continue;
      }
      updateLock(
        lockPath,
        (current) => current?.token === lock.token
          && !current.detached
          && this.lockOwnerState(current) === 'absent'
      );
    }
  }

  lockOwnerState(lock, identityCache) {
    const hostState = this.hostOwnerState(lock, identityCache);
    if (hostState === 'available') {
      return 'available';
    }
    const childLiveness = Number.isInteger(lock?.childPid) && lock.childPid > 0
      ? this.processLiveness(lock.childPid)
      : false;
    if (childLiveness === true) {
      return 'available';
    }
    if (hostState === 'uncertain' || childLiveness === undefined) {
      return 'uncertain';
    }
    return 'absent';
  }

  hostOwnerState(lock, identityCache) {
    const identityDecision = this.hostIdentityDecision(lock, identityCache);
    return runtimeHostOwnerState(identityDecision, {
      heartbeatAt: lock?.heartbeatAt,
      heartbeatTimeoutMs: this.ownerHeartbeatTimeoutMs,
      now: this.now()
    });
  }

  hostIdentityDecision(lock, identityCache) {
    return runtimeProcessOwnerDecision({
      cache: identityCache,
      currentIdentity: this.hostIdentity,
      currentPid: this.pid,
      expectedIdentity: lock?.hostIdentity,
      isProcessAlive: this.isProcessAlive,
      now: this.now,
      pid: lock?.pid,
      platform: lock?.platform || this.platform,
      readProcessIdentity: this.readHostProcessIdentity
    });
  }

  processLiveness(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    try {
      const alive = this.isProcessAlive(pid);
      return typeof alive === 'boolean' ? alive : undefined;
    } catch {
      return undefined;
    }
  }

  lockFiles() {
    return fs.readdirSync(this.directory).filter((filename) => /^port-\d+\.lock$/.test(filename));
  }

  lockPath(port) {
    return path.join(this.directory, `port-${port}.lock`);
  }

  withReservationTransaction(operation) {
    const transactionPath = path.join(this.directory, '.reservation-transaction.lock');
    return withExclusiveJsonLock({
      createRecord: (token, createdAt) => ({
        pid: process.pid,
        ...(CURRENT_PROCESS_IDENTITY ? { processIdentity: CURRENT_PROCESS_IDENTITY } : {}),
        createdAt,
        token
      }),
      diagnose: (event, details) => this.diagnose(event, details),
      diagnoseImmediate: false,
      events: {
        acquired: 'transaction.acquired',
        staleRecovered: 'transaction.stale-recovered',
        timeout: 'transaction.timeout'
      },
      lockKind: 'port-transaction',
      lockPath: transactionPath,
      maxAttempts: LOCK_UPDATE_MAX_ATTEMPTS,
      now: this.now,
      observe: () => readLock(transactionPath),
      ownerIsAbandoned: (record, identityCache) => transientLockIsAbandoned(
        transactionPath,
        record,
        this.invalidRecordGraceMs,
        this.now(),
        identityCache
      ),
      recordFromObservation: (record) => record,
      removeInvalid: () => removeInvalidLock(
        transactionPath,
        this.invalidRecordGraceMs,
        this.now()
      ),
      removeObserved: (observed, canRemove) => updateLock(
        transactionPath,
        (current) => current?.token === observed.token && canRemove(current)
      ),
      retryMs: LOCK_UPDATE_RETRY_MS,
      timeoutError: () => new Error('Runlist could not safely coordinate shared port reservations.'),
      wait: (milliseconds) => Atomics.wait(LOCK_UPDATE_WAIT, 0, 0, milliseconds)
    }, operation);
  }

  diagnose(event, details) {
    try {
      this.onDiagnostic?.(event, details);
    } catch {
      // Local diagnostics must never alter port coordination behavior.
    }
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
