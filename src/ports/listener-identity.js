const {
  processIdentityDecision,
  stableProcessIdentity
} = require('../lifecycle/process-identity');

/**
 * Resolve who owns the listener on one port from OS evidence + Runlist ownership.
 * Read-only: never terminates processes.
 */
function resolvePortListenerIdentity(options = {}) {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: 'unknown', port, reason: 'invalid-port' };
  }

  const platform = options.platform || process.platform;
  const projectsById = projectIndex(options.projects);
  const runtime = ownershipEntries(options.processRuntime);
  const listeners = listenersOnPort(options.listeners, port);

  if (!listeners.length) {
    return { kind: 'gone', port };
  }

  const distinctPids = [...new Set(listeners.map((listener) => listener.pid))];
  if (distinctPids.length > 1) {
    return {
      kind: 'ambiguous',
      port,
      reason: 'multiple-listeners',
      listeners: summarizeListeners(listeners)
    };
  }

  const listener = listeners[0];
  const matches = [];
  let pidReuse = false;

  for (const [projectId, ownership] of runtime) {
    const decision = ownedListenerDecision(listener, ownership, platform);
    if (decision === 'owned') {
      matches.push(projectId);
    } else if (decision === 'pid-reuse') {
      pidReuse = true;
    }
  }

  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      port,
      reason: 'multiple-owners',
      projectIds: matches,
      pid: listener.pid,
      name: listenerName(listener),
      identity: stableProcessIdentity(listener.identity) ? listener.identity : undefined,
      listeners: summarizeListeners(listeners)
    };
  }

  if (matches.length === 1) {
    const projectId = matches[0];
    const project = projectsById.get(projectId);
    return {
      kind: 'owned',
      port,
      projectId,
      projectName: projectName(project, projectId),
      pid: listener.pid,
      name: listenerName(listener),
      identity: stableProcessIdentity(listener.identity) ? listener.identity : undefined
    };
  }

  if (pidReuse) {
    return {
      kind: 'unknown',
      port,
      reason: 'pid-reuse',
      pid: listener.pid,
      name: listenerName(listener),
      identity: stableProcessIdentity(listener.identity) ? listener.identity : undefined
    };
  }

  if (!stableProcessIdentity(listener.identity)) {
    return {
      kind: 'unknown',
      port,
      reason: 'missing-identity',
      pid: listener.pid,
      name: listenerName(listener)
    };
  }

  return {
    kind: 'external',
    port,
    pid: listener.pid,
    name: listenerName(listener),
    identity: listener.identity
  };
}

function ownedListenerDecision(listener, ownership, platform) {
  if (!ownership || !Number.isInteger(listener?.pid) || listener.pid <= 0) {
    return null;
  }

  const detached = Array.isArray(ownership.detachedServiceListeners)
    ? ownership.detachedServiceListeners
    : [];
  for (const expected of detached) {
    if (expected?.port !== listener.port || expected?.pid !== listener.pid) {
      continue;
    }
    const decision = processIdentityDecision(
      expected.identity,
      listener.identity,
      platform,
      listener.pid,
      { allowRuntime: true }
    );
    if (decision === 'match') {
      return 'owned';
    }
    if (decision === 'mismatch' || decision === 'unavailable') {
      return 'pid-reuse';
    }
  }

  const childCandidates = [
    {
      pid: ownership.childPid,
      identity: ownership.childIdentity,
      active: ownership.processActive === true || ownership.ownerAvailable === true
    },
    {
      pid: ownership.detachedChildPid,
      identity: ownership.detachedChildIdentity,
      active: ownership.detached === true
    }
  ];

  for (const candidate of childCandidates) {
    if (candidate.pid !== listener.pid) {
      continue;
    }
    const decision = processIdentityDecision(
      candidate.identity,
      listener.identity,
      platform,
      listener.pid,
      { allowRuntime: true }
    );
    if (decision === 'match' && candidate.active) {
      return 'owned';
    }
    if (decision === 'mismatch' || decision === 'unavailable' || !candidate.active) {
      // Same PID as a recorded Runlist child without confirming identity/activity.
      return 'pid-reuse';
    }
  }

  return null;
}

function listenersOnPort(listeners, port) {
  if (!Array.isArray(listeners)) {
    return [];
  }
  return listeners.filter((listener) => (
    listener
      && listener.port === port
      && Number.isInteger(listener.pid)
      && listener.pid > 0
  ));
}

function ownershipEntries(processRuntime) {
  if (!processRuntime) {
    return [];
  }
  if (processRuntime instanceof Map) {
    return [...processRuntime.entries()];
  }
  if (typeof processRuntime === 'object') {
    return Object.entries(processRuntime);
  }
  return [];
}

function projectIndex(projects) {
  const index = new Map();
  if (!Array.isArray(projects)) {
    return index;
  }
  for (const project of projects) {
    if (project && typeof project.id === 'string') {
      index.set(project.id, project);
    }
  }
  return index;
}

function projectName(project, projectId) {
  if (project && typeof project.name === 'string' && project.name.trim()) {
    return project.name;
  }
  return projectId;
}

function listenerName(listener) {
  return typeof listener?.name === 'string' && listener.name.trim()
    ? listener.name
    : 'unknown';
}

function summarizeListeners(listeners) {
  return listeners.map((listener) => ({
    port: listener.port,
    pid: listener.pid,
    name: listenerName(listener),
    ...(stableProcessIdentity(listener.identity) ? { identity: listener.identity } : {})
  }));
}

module.exports = {
  ownedListenerDecision,
  resolvePortListenerIdentity
};
