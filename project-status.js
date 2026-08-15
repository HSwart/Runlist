const net = require('net');
const { safeServiceUrl } = require('./external-url');

function isPortOpen(port, options = {}) {
  const host = options.host || '127.0.0.1';
  const timeout = options.timeout || 300;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function servicePortStatus(services) {
  if (!Array.isArray(services) || services.length === 0) {
    return { allOpen: false, anyOpen: false, openPorts: [] };
  }
  const results = await Promise.all(services.map((service) => isPortOpen(service.port)));
  return {
    allOpen: results.every(Boolean),
    anyOpen: results.some(Boolean),
    openPorts: services.filter((_, index) => results[index]).map((service) => service.port)
  };
}

async function areServicesRunning(services) {
  return (await servicePortStatus(services)).allOpen;
}

function projectStatus({
  ambiguousConflict = false,
  allOpen = false,
  anyOpen = false,
  hasServices = false,
  knownConflict = false,
  managed = false,
  processActive = false,
  stopping = false,
  withinStartGrace = false
}) {
  if (stopping) {
    return 'stopping';
  }
  if (managed && withinStartGrace) {
    return 'starting';
  }
  if (managed && processActive) {
    return 'running';
  }
  if (!hasServices) {
    return managed || processActive ? 'running' : 'stopped';
  }
  if (allOpen) {
    return managed
      ? 'running'
      : knownConflict
        ? 'port-in-use'
        : ambiguousConflict
          ? 'port-in-use-unknown'
          : 'active';
  }
  if (anyOpen) {
    return managed
      ? 'starting'
      : knownConflict
        ? 'port-in-use'
        : ambiguousConflict
          ? 'port-in-use-unknown'
          : 'active';
  }
  if (managed) {
    return 'running';
  }
  return 'stopped';
}

function primaryServiceUrl(services) {
  const service = services?.[0];
  const override = typeof service?.url === 'string' ? service.url.trim() : '';
  if (override) {
    return safeServiceUrl(override);
  }
  const port = service?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return `http://127.0.0.1:${port}`;
}

function stoppableProjectIds(projects) {
  return (projects || [])
    .filter((project) => !project.reviewRequired
      && ['running', 'starting', 'active'].includes(project.status))
    .map((project) => project.id);
}

module.exports = {
  areServicesRunning,
  isPortOpen,
  primaryServiceUrl,
  projectStatus,
  servicePortStatus,
  stoppableProjectIds
};
