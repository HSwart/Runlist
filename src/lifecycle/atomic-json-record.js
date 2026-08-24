const crypto = require('crypto');
const fs = require('fs');
const {
  processIdentityDecision,
  readProcessIdentitySync,
  stableProcessIdentity
} = require('./process-identity');

const DEFAULT_INVALID_RECORD_GRACE_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 200;
const DEFAULT_RETRY_MS = 5;
const UPDATE_WAIT = new Int32Array(new SharedArrayBuffer(4));

function createAtomicJsonRecordUpdater(options = {}) {
  if (typeof options.writeFileAtomically !== 'function') {
    throw new TypeError('Expected an atomic file writer.');
  }
  const currentPid = options.pid ?? process.pid;
  const currentIdentity = stableProcessIdentity(options.processIdentity)
    ? options.processIdentity
    : undefined;
  const platform = options.platform || process.platform;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const invalidRecordGraceMs = options.invalidRecordGraceMs
    ?? DEFAULT_INVALID_RECORD_GRACE_MS;
  const now = options.now || Date.now;
  const wait = options.wait || ((milliseconds) => {
    Atomics.wait(UPDATE_WAIT, 0, 0, milliseconds);
  });
  const isProcessAlive = options.isProcessAlive || processIsAlive;
  const readIdentity = options.readProcessIdentitySync || readProcessIdentitySync;
  const errorMessage = options.errorMessage
    || 'Runlist could not safely update a shared record.';

  function update(filePath, matches, replacement) {
    const updatePath = `${filePath}.update`;
    let acquired = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let descriptor;
      try {
        descriptor = fs.openSync(updatePath, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({
          pid: currentPid,
          ...(currentIdentity ? { processIdentity: currentIdentity } : {}),
          createdAt: now()
        }));
        fs.closeSync(descriptor);
        descriptor = undefined;
        acquired = true;
        break;
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
          } finally {
            tryUnlink(updatePath);
          }
        }
        if (error.code !== 'EEXIST') {
          throw error;
        }
        if (markerIsAbandoned(updatePath, invalidRecordGraceMs, now())) {
          tryUnlink(updatePath);
          continue;
        }
        wait(retryMs);
      }
    }
    if (!acquired) {
      throw new Error(errorMessage);
    }
    try {
      const current = readJsonRecord(filePath);
      const fingerprint = jsonRecordFingerprint(filePath);
      if (!matches(current, fingerprint)) {
        return false;
      }
      if (typeof replacement === 'function') {
        options.writeFileAtomically(filePath, JSON.stringify(replacement(current)));
      } else {
        tryUnlink(filePath);
      }
      return true;
    } finally {
      tryUnlink(updatePath);
    }
  }

  function removeInvalid(filePath, graceMs = invalidRecordGraceMs, timestamp = now()) {
    if (!invalidJsonRecordIsStale(filePath, graceMs, timestamp)) {
      return false;
    }
    const observedFingerprint = jsonRecordFingerprint(filePath);
    if (!observedFingerprint) {
      return false;
    }
    return update(
      filePath,
      (current, fingerprint) => !current && fingerprint === observedFingerprint
    );
  }

  function markerIsAbandoned(
    filePath,
    graceMs = invalidRecordGraceMs,
    timestamp = now()
  ) {
    return transientRecordIsAbandoned(
      filePath,
      readJsonRecord(filePath),
      graceMs,
      timestamp
    );
  }

  function transientRecordIsAbandoned(
    filePath,
    marker,
    graceMs = invalidRecordGraceMs,
    timestamp = now()
  ) {
    if (!Number.isInteger(marker?.pid) || marker.pid <= 0) {
      return invalidJsonRecordIsStale(filePath, graceMs, timestamp);
    }
    if (!isProcessAlive(marker.pid)) {
      return true;
    }
    const observedIdentity = marker.pid === currentPid
      ? currentIdentity
      : readIdentity(marker.pid, platform);
    if (typeof marker.processIdentity === 'string') {
      return processIdentityDecision(
        marker.processIdentity,
        observedIdentity,
        platform,
        marker.pid,
        { allowRuntime: true }
      ) === 'mismatch';
    }
    return invalidJsonRecordIsStale(filePath, graceMs, timestamp);
  }

  return {
    markerIsAbandoned,
    removeInvalid,
    transientRecordIsAbandoned,
    update
  };
}

function readJsonRecord(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function invalidJsonRecordIsStale(filePath, graceMs, now) {
  try {
    return now - fs.statSync(filePath).mtimeMs >= graceMs;
  } catch {
    return false;
  }
}

function jsonRecordFingerprint(filePath) {
  try {
    const contents = fs.readFileSync(filePath);
    const stat = fs.statSync(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${crypto
      .createHash('sha256')
      .update(contents)
      .digest('hex')}`;
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

module.exports = {
  createAtomicJsonRecordUpdater,
  invalidJsonRecordIsStale,
  jsonRecordFingerprint,
  processIsAlive,
  readJsonRecord,
  tryUnlink
};
