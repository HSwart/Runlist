const {
  processIdentityDecision,
  readProcessIdentitySync,
  stableProcessIdentity
} = require('./process-identity');

function processLockOwnerDecision(record, options = {}) {
  if (!Number.isInteger(record?.pid) || record.pid <= 0) {
    return 'uncertain';
  }
  const presence = processPresence(record.pid, options);
  if (presence === 'absent') {
    return 'absent';
  }
  if (presence !== 'alive') {
    return 'uncertain';
  }
  if (!stableProcessIdentity(record.processIdentity)) {
    return 'uncertain';
  }
  const currentPid = options.currentPid ?? process.pid;
  let currentIdentity;
  try {
    currentIdentity = record.pid === currentPid
      ? options.currentProcessIdentity
      : (options.readProcessIdentitySync || readProcessIdentitySync)(
        record.pid,
        options.platform || process.platform
      );
  } catch {
    return 'uncertain';
  }
  const identityDecision = processIdentityDecision(
    record.processIdentity,
    currentIdentity,
    options.platform || process.platform,
    record.pid,
    { allowRuntime: options.allowRuntime === true }
  );
  if (identityDecision === 'match') {
    return 'active';
  }
  return identityDecision === 'mismatch' ? 'absent' : 'uncertain';
}

function processLockRecordIsAbandoned(record, options) {
  return processLockOwnerDecision(record, options) === 'absent';
}

function processPresence(pid, options = {}) {
  if (typeof options.isProcessAlive === 'function') {
    try {
      return options.isProcessAlive(pid) ? 'alive' : 'absent';
    } catch {
      return 'uncertain';
    }
  }
  const kill = options.kill || process.kill;
  try {
    kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error.code === 'ESRCH') {
      return 'absent';
    }
    return error.code === 'EPERM' ? 'alive' : 'uncertain';
  }
}

module.exports = {
  processLockOwnerDecision,
  processLockRecordIsAbandoned,
  processPresence
};
