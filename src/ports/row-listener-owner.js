const { resolvePortListenerIdentity } = require('./listener-identity');
const { plainLanguageForIdentity } = require('./port-listening-report');

const ROW_LISTENER_STATUSES = new Set([
  'running',
  'active',
  'starting',
  'not-ready',
  'not-responding',
  'ownership-lost',
  'port-in-use',
  'port-in-use-unknown'
]);

/**
 * Compact owner presentation for Frame B line 2 — identity only, no kill chrome.
 */
function presentRowListenerOwner(options = {}) {
  const projectId = typeof options.projectId === 'string' ? options.projectId : '';
  const identity = options.identity;
  if (!identity || !ROW_LISTENER_STATUSES.has(options.status)) {
    return undefined;
  }

  if (identity.kind === 'gone') {
    return undefined;
  }

  if (identity.kind === 'owned') {
    if (identity.projectId === projectId) {
      return {
        kind: 'this-app',
        label: '',
        announcement: 'Port owned by this app',
        title: 'This app owns the listener on its configured port.',
        revealProjectId: undefined
      };
    }
    const name = typeof identity.projectName === 'string' && identity.projectName.trim()
      ? identity.projectName
      : (identity.projectId || 'Another Runlist app');
    return {
      kind: 'other-runlist',
      label: name,
      announcement: `Port owned by another Runlist app, ${name}`,
      title: `Show ${name} in Runlist`,
      revealProjectId: typeof identity.projectId === 'string' ? identity.projectId : undefined
    };
  }

  if (identity.kind === 'external') {
    const name = typeof identity.name === 'string' && identity.name.trim()
      ? identity.name
      : 'External process';
    const pid = Number.isInteger(identity.pid) && identity.pid > 0 ? identity.pid : undefined;
    const label = pid ? `${name} · PID ${pid}` : name;
    return {
      kind: 'external',
      label,
      announcement: `Port owned by external process ${label}`,
      title: plainLanguageForIdentity(identity),
      revealProjectId: undefined
    };
  }

  const plain = plainLanguageForIdentity(identity);
  return {
    kind: identity.kind === 'ambiguous' ? 'ambiguous' : 'unknown',
    label: 'Owner unclear',
    announcement: plain,
    title: plain,
    revealProjectId: undefined
  };
}

function rowListenerProbePort(options = {}) {
  const conflictPort = Number(options.portConflict?.port);
  if (Number.isInteger(conflictPort) && conflictPort >= 1 && conflictPort <= 65535) {
    return conflictPort;
  }
  const openPorts = Array.isArray(options.openPorts) ? options.openPorts : [];
  const firstOpen = openPorts.find((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  if (firstOpen !== undefined) {
    return firstOpen;
  }
  const services = Array.isArray(options.services) ? options.services : [];
  for (const service of services) {
    const port = Number(service?.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
  }
  return undefined;
}

function buildProjectListenerOwners(options = {}) {
  const projects = Array.isArray(options.projects) ? options.projects : [];
  const statuses = options.statuses instanceof Map ? options.statuses : new Map();
  const openPortsById = options.openPorts instanceof Map ? options.openPorts : new Map();
  const conflicts = options.conflicts instanceof Map ? options.conflicts : new Map();
  const listeners = Array.isArray(options.listeners) ? options.listeners : [];
  const owners = new Map();

  for (const project of projects) {
    if (!project || typeof project.id !== 'string') {
      continue;
    }
    const status = statuses.get(project.id);
    if (!ROW_LISTENER_STATUSES.has(status)) {
      continue;
    }
    const port = rowListenerProbePort({
      portConflict: conflicts.get(project.id),
      openPorts: openPortsById.get(project.id),
      services: project.services
    });
    if (port === undefined) {
      continue;
    }
    const identity = resolvePortListenerIdentity({
      port,
      listeners,
      projects,
      processRuntime: options.processRuntime,
      platform: options.platform
    });
    const presented = presentRowListenerOwner({
      identity,
      projectId: project.id,
      status
    });
    if (presented) {
      owners.set(project.id, presented);
    }
  }
  return owners;
}

function listenerOwnerMapsDiffer(left, right) {
  const leftMap = left instanceof Map ? left : new Map();
  const rightMap = right instanceof Map ? right : new Map();
  if (leftMap.size !== rightMap.size) {
    return true;
  }
  return [...leftMap].some(([id, owner]) => {
    const previous = rightMap.get(id);
    return !previous
      || previous.kind !== owner.kind
      || previous.label !== owner.label
      || previous.announcement !== owner.announcement
      || previous.title !== owner.title
      || previous.revealProjectId !== owner.revealProjectId;
  });
}

module.exports = {
  ROW_LISTENER_STATUSES,
  buildProjectListenerOwners,
  listenerOwnerMapsDiffer,
  presentRowListenerOwner,
  rowListenerProbePort
};
