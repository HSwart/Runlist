const {
  processIdentityDecision,
  stableProcessIdentity
} = require('./process-identity');

function runtimeProcessOwnerDecision(options = {}) {
  const pid = options.pid;
  if (!stableProcessIdentity(options.expectedIdentity)) {
    const presence = processLiveness(pid, options.isProcessAlive);
    return presence === false ? 'absent' : 'unavailable';
  }

  const platform = options.platform || process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const cacheKey = `${pid}:${platform}:${options.expectedIdentity}`;
  const now = (options.now || Date.now)();
  const cached = !options.fresh ? options.cache?.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > now) {
    return cached.decision;
  }

  let currentIdentity;
  if (pid === currentPid) {
    currentIdentity = options.currentIdentity;
  } else {
    try {
      currentIdentity = options.readProcessIdentity?.(pid, platform);
    } catch {
      currentIdentity = undefined;
    }
  }

  let decision;
  if (!stableProcessIdentity(currentIdentity)) {
    const presence = processLiveness(pid, options.isProcessAlive);
    decision = presence === false ? 'absent' : 'unavailable';
  } else {
    const identityDecision = processIdentityDecision(
      options.expectedIdentity,
      currentIdentity,
      platform,
      pid,
      { allowRuntime: true }
    );
    if (identityDecision === 'mismatch') {
      decision = 'mismatch';
    } else {
      const presence = processLiveness(pid, options.isProcessAlive);
      decision = identityDecision === 'match' && presence === true
        ? 'match'
        : presence === false ? 'absent' : 'unavailable';
    }
  }

  if (!options.fresh && options.cache) {
    const cacheTtlMs = options.cacheTtlMs ?? Number.POSITIVE_INFINITY;
    options.cache.set(cacheKey, {
      decision,
      expiresAt: now + cacheTtlMs
    });
  }
  return decision;
}

function runtimeHostOwnerState(identityDecision, options = {}) {
  if (identityDecision === 'unavailable') {
    return 'uncertain';
  }
  const heartbeatCurrent = !Number.isFinite(options.heartbeatAt)
    || options.now - options.heartbeatAt <= options.heartbeatTimeoutMs;
  return identityDecision === 'match' && heartbeatCurrent
    ? 'available'
    : 'absent';
}

function processLiveness(pid, isProcessAlive) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof isProcessAlive !== 'function') {
    return undefined;
  }
  try {
    const alive = isProcessAlive(pid);
    return typeof alive === 'boolean' ? alive : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  runtimeHostOwnerState,
  runtimeProcessOwnerDecision
};
