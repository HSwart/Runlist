const { resolvePortListenerIdentity } = require('./listener-identity');
const { servicePorts } = require('./port-gate');

function configuredProjectPorts(projects) {
  const ports = new Set();
  const portProjects = new Map();
  if (!Array.isArray(projects)) {
    return { ports: [], portProjects };
  }
  for (const project of projects) {
    if (!project || typeof project.id !== 'string') {
      continue;
    }
    for (const port of servicePorts(project)) {
      ports.add(port);
      const owners = portProjects.get(port) || [];
      owners.push({
        id: project.id,
        name: typeof project.name === 'string' && project.name.trim()
          ? project.name
          : project.id
      });
      portProjects.set(port, owners);
    }
  }
  return {
    ports: [...ports].sort((left, right) => left - right),
    portProjects
  };
}

function buildPortListeningReport(options = {}) {
  const { ports, portProjects } = configuredProjectPorts(options.projects);
  const listeners = Array.isArray(options.listeners) ? options.listeners : [];
  const scannedAt = Number.isFinite(options.scannedAt) ? options.scannedAt : Date.now();
  const rows = ports.map((port) => {
    const identity = resolvePortListenerIdentity({
      port,
      listeners,
      projects: options.projects,
      processRuntime: options.processRuntime,
      platform: options.platform
    });
    const configuredProjects = portProjects.get(port) || [];
    return presentPortListeningRow(identity, configuredProjects);
  });
  return {
    scannedAt,
    rows,
    empty: rows.length === 0
  };
}

function presentPortListeningRow(identity, configuredProjects) {
  const kind = identity?.kind || 'unknown';
  const port = identity?.port;
  const plainReason = plainLanguageForIdentity(identity);
  const canReveal = kind === 'owned' && typeof identity.projectId === 'string';
  const closeProjectId = kind === 'owned'
    ? identity.projectId
    : kind === 'external' && configuredProjects.length === 1
      ? configuredProjects[0].id
      : undefined;
  const canClose = Boolean(closeProjectId)
    && (kind === 'owned' || kind === 'external')
    && Number.isInteger(identity?.pid)
    && identity.pid > 0;

  return {
    port,
    kind,
    pid: Number.isInteger(identity?.pid) ? identity.pid : undefined,
    name: typeof identity?.name === 'string' ? identity.name : undefined,
    identity: typeof identity?.identity === 'string' ? identity.identity : undefined,
    projectId: typeof identity?.projectId === 'string' ? identity.projectId : undefined,
    projectName: typeof identity?.projectName === 'string' ? identity.projectName : undefined,
    configuredProjects,
    reason: typeof identity?.reason === 'string' ? identity.reason : undefined,
    plainReason,
    canReveal,
    canClose,
    closeProjectId
  };
}

function plainLanguageForIdentity(identity) {
  switch (identity?.kind) {
    case 'owned':
      return `Runlist project ${identity.projectName || identity.projectId} owns this listener.`;
    case 'external':
      return `${identity.name || 'A process'} (PID ${identity.pid}) is listening. It is not confirmed as this Runlist window's owned process.`;
    case 'gone':
      return 'Nothing is listening on this port right now.';
    case 'ambiguous':
      if (identity.reason === 'multiple-listeners') {
        return 'More than one process is listening on this port, so Runlist will not guess the owner.';
      }
      if (identity.reason === 'multiple-owners') {
        return 'More than one Runlist project claims this listener, so ownership is unclear.';
      }
      return 'Ownership is unclear for this port.';
    case 'unknown':
      if (identity.reason === 'missing-identity') {
        return 'A process is listening, but Runlist could not confirm which process it is.';
      }
      if (identity.reason === 'pid-reuse') {
        return 'This PID no longer matches the process identity Runlist recorded, so ownership is unknown.';
      }
      return 'Runlist could not confirm who owns this port.';
    default:
      return 'Runlist could not confirm who owns this port.';
  }
}

function formatPortListenerClipboardLine(row) {
  const parts = [`:${row.port}`];
  if (row.kind === 'gone') {
    parts.push('nothing listening');
  } else {
    if (row.name) {
      parts.push(row.name);
    }
    if (Number.isInteger(row.pid)) {
      parts.push(`PID ${row.pid}`);
    }
    if (row.kind === 'owned' && row.projectName) {
      parts.push(`Runlist: ${row.projectName}`);
    } else if (row.kind === 'external') {
      parts.push('external');
    } else {
      parts.push(row.kind || 'unknown');
    }
  }
  if (row.plainReason) {
    parts.push(row.plainReason);
  }
  return parts.join(' — ');
}

function formatPortListeningClipboard(report) {
  if (!report?.rows?.length) {
    return 'Runlist: no configured project ports to check.';
  }
  return [
    'Runlist — what\'s listening',
    ...report.rows.map((row) => formatPortListenerClipboardLine(row))
  ].join('\n');
}

module.exports = {
  buildPortListeningReport,
  configuredProjectPorts,
  formatPortListeningClipboard,
  formatPortListenerClipboardLine,
  plainLanguageForIdentity,
  presentPortListeningRow
};
