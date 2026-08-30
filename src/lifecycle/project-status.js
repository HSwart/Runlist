const net = require('net');
const http = require('http');
const https = require('https');
const { safeServiceUrl } = require('../services/external-url');

const HTTP_PROBE_TIMEOUT_MS = 700;
const TIMED_OUT = Symbol('timed-out');

function isPortOpen(port, options = {}) {
  const hosts = options.hosts || (options.host ? [options.host] : ['127.0.0.1', '::1']);
  return Promise.all(hosts.map((host) => isHostPortOpen(port, host, options)))
    .then((results) => results.some(Boolean));
}

function isHostPortOpen(port, host, options) {
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
  const results = await Promise.all(services.map((service) => isPortOpen(service.port, {
    hosts: servicePortHosts(service)
  })));
  return {
    allOpen: results.every(Boolean),
    anyOpen: results.some(Boolean),
    openPorts: services.filter((_, index) => results[index]).map((service) => service.port)
  };
}

function servicePortHosts(service) {
  const url = httpServiceUrl(service);
  if (!url) {
    return ['127.0.0.1', '::1'];
  }
  try {
    const host = new URL(url).hostname.toLocaleLowerCase('en-US');
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
      return [host];
    }
    if (host === '[::1]') {
      return ['::1'];
    }
  } catch {
    // Stored URLs are validated; fall back to both standard loopbacks.
  }
  return ['127.0.0.1', '::1'];
}

async function areServicesRunning(services) {
  return (await servicePortStatus(services)).allOpen;
}

function httpServiceUrl(service) {
  const override = typeof service?.url === 'string' ? service.url.trim() : '';
  return override ? safeServiceUrl(override) : undefined;
}

function ipv6LoopbackAlternate(url) {
  const safeUrl = safeServiceUrl(url);
  if (!safeUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(safeUrl);
    if (parsed.hostname.toLocaleLowerCase('en-US') !== 'localhost') {
      return undefined;
    }
    parsed.hostname = '[::1]';
    return safeServiceUrl(parsed.toString());
  } catch {
    return undefined;
  }
}

function healthCheckUrlCandidates(check) {
  return [...new Set([
    check?.url,
    check?.alternateUrl,
    ...(Array.isArray(check?.alternateUrls) ? check.alternateUrls : [])
  ].filter(Boolean))];
}

function serviceHealthCheck(service) {
  const configured = service?.healthCheck;
  if (!configured) {
    const url = httpServiceUrl(service);
    const alternateUrl = ipv6LoopbackAlternate(url);
    return url
      ? {
          mode: 'http',
          url,
          ...(alternateUrl ? { alternateUrl } : {}),
          method: 'HEAD',
          timeout: HTTP_PROBE_TIMEOUT_MS,
          retries: 0
        }
      : { mode: 'port' };
  }
  if (configured.mode === 'port') {
    return { mode: 'port' };
  }
  const base = serviceUrl(service);
  const target = typeof configured.target === 'string' ? configured.target.trim() : '';
  let url;
  if (!target) {
    url = httpServiceUrl(service) || base;
  } else if (target.startsWith('/')) {
    try {
      const baseUrl = new URL(base);
      const resolvedUrl = new URL(target, baseUrl);
      url = resolvedUrl.origin === baseUrl.origin
        ? safeServiceUrl(resolvedUrl.toString())
        : undefined;
    } catch {
      url = undefined;
    }
  } else {
    url = safeServiceUrl(target);
  }
  const alternateUrls = [
    ipv6LoopbackAlternate(url),
    target.startsWith('/') && !httpServiceUrl(service)
      ? safeServiceUrl(new URL(
        target,
        `http://[::1]:${service.port}`
      ).toString())
      : undefined
  ].filter(Boolean).filter((candidate, index, candidates) => candidates.indexOf(candidate) === index && candidate !== url);
  return {
    mode: 'http',
    url,
    ...(alternateUrls.length > 0
      ? {
          alternateUrl: alternateUrls[0],
          ...(alternateUrls.length > 1 ? { alternateUrls: alternateUrls.slice(1) } : {})
        }
      : {}),
    method: configured.method || (configured.bodyContains ? 'GET' : 'HEAD'),
    expectedStatus: configured.expectedStatus,
    timeout: configured.timeoutMs || HTTP_PROBE_TIMEOUT_MS,
    retries: configured.retries || 0,
    ...(configured.bodyContains ? { bodyContains: configured.bodyContains } : {})
  };
}

function serviceUrl(service) {
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

function probeHttpService(url, options = {}) {
  const safeUrl = safeServiceUrl(url);
  if (!safeUrl) {
    return Promise.resolve(false);
  }

  const timeout = Number.isFinite(options.timeout)
    ? Math.max(1, options.timeout)
    : HTTP_PROBE_TIMEOUT_MS;
  const transport = new URL(safeUrl).protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    let request;
    let timer;
    const finish = (responding) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(responding);
    };

    timer = setTimeout(() => {
      finish(false);
      request?.destroy();
    }, timeout);

    try {
      request = transport.request(safeUrl, { method: options.method || 'HEAD' }, (response) => {
        if (options.bodyContains) {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
            if (body.length > 65536) {
              response.destroy();
            }
          });
          response.on('end', () => {
            const statusOk = options.expectedStatus === undefined
              || response.statusCode === options.expectedStatus;
            finish(statusOk && body.includes(options.bodyContains));
          });
          response.on('error', () => finish(false));
          return;
        }
        response.resume();
        finish(options.expectedStatus === undefined
          || response.statusCode === options.expectedStatus);
      });
      request.once('error', () => finish(false));
      request.end();
    } catch {
      request?.destroy();
      finish(false);
    }
  });
}

async function serviceHttpStatus(services, openPorts, options = {}) {
  const configured = (services || [])
    .map((service) => ({ service, check: serviceHealthCheck(service) }))
    .filter(({ check }) => check.mode === 'http');
  if (configured.length === 0) {
    return {
      allResponding: true,
      respondingPorts: [],
      unresponsivePorts: [],
      webPorts: []
    };
  }

  const open = new Set(openPorts || []);
  const resolveUrl = options.resolveUrl || (async (url) => url);
  const probe = options.probe || probeHttpService;
  const timeout = Number.isFinite(options.timeout)
    ? Math.max(1, options.timeout)
    : HTTP_PROBE_TIMEOUT_MS;
  const results = await Promise.all(configured.map(async ({ service, check }) => {
    if (!open.has(service.port)) {
      return false;
    }
    if (!check.url) {
      return false;
    }
    try {
      const attemptTimeout = Number.isFinite(service.healthCheck?.timeoutMs)
        ? service.healthCheck.timeoutMs
        : timeout;
      for (const candidateUrl of healthCheckUrlCandidates(check)) {
        const resolvedUrl = await valueWithin(
          () => resolveUrl(candidateUrl, service),
          attemptTimeout
        );
        if (resolvedUrl === TIMED_OUT) {
          continue;
        }
        for (let attempt = 0; attempt <= check.retries; attempt += 1) {
          const responding = await valueWithin(
            () => probe(resolvedUrl, {
              timeout: attemptTimeout,
              method: check.method,
              ...(check.expectedStatus === undefined ? {} : { expectedStatus: check.expectedStatus }),
              ...(check.bodyContains ? { bodyContains: check.bodyContains } : {})
            }),
            attemptTimeout
          );
          if (responding !== TIMED_OUT && responding) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }));

  return {
    allResponding: results.every(Boolean),
    respondingPorts: configured
      .filter((_, index) => results[index])
      .map(({ service }) => service.port),
    unresponsivePorts: configured
      .filter(({ service }, index) => open.has(service.port) && !results[index])
      .map(({ service }) => service.port),
    webPorts: configured.map(({ service }) => service.port)
  };
}

async function reachableServiceUrls(services, openPorts, options = {}) {
  const open = new Set(openPorts || []);
  const configured = (services || [])
    .map((service, index) => ({
      service,
      urls: serviceUrlCandidates(service),
      webCandidate: index === 0 || Boolean(httpServiceUrl(service))
    }))
    .filter(({ service, webCandidate }) => open.has(service.port) && webCandidate)
    .filter(({ urls }) => urls.length > 0);
  const resolveUrl = options.resolveUrl || (async (url) => url);
  const probe = options.probe || probeHttpService;
  const timeout = Number.isFinite(options.timeout)
    ? Math.max(1, options.timeout)
    : HTTP_PROBE_TIMEOUT_MS;
  const now = options.now || Date.now;

  const results = await Promise.all(configured.map(async ({ service, urls }) => {
    try {
      const healthCheck = serviceHealthCheck(service);
      const attemptTimeout = timeout;
      const deadline = Date.now() + attemptTimeout;
      const probeStartedAt = now();
      for (const url of urls) {
        const remainingForResolution = Math.max(1, deadline - Date.now());
        const resolvedUrl = await valueWithin(
          () => resolveUrl(url, service),
          remainingForResolution
        );
        if (resolvedUrl === TIMED_OUT || !safeServiceUrl(resolvedUrl)) {
          continue;
        }
        const remainingForProbe = Math.max(1, deadline - Date.now());
        const responding = await valueWithin(
          () => probe(resolvedUrl, {
            timeout: remainingForProbe,
            method: healthCheck.mode === 'http' ? healthCheck.method : 'HEAD'
          }),
          remainingForProbe
        );
        if (responding !== TIMED_OUT && responding) {
          return {
            port: service.port,
            url: safeServiceUrl(resolvedUrl),
            responseTimeMs: Math.max(1, now() - probeStartedAt)
          };
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }));

  return results.filter(Boolean);
}

function serviceUrlCandidates(service) {
  const url = serviceUrl(service);
  if (!url) {
    return url ? [url] : [];
  }
  const explicitUrl = httpServiceUrl(service);
  const alternateUrl = ipv6LoopbackAlternate(explicitUrl);
  if (explicitUrl) {
    return [url, alternateUrl].filter(Boolean);
  }
  return [url, `http://[::1]:${service.port}`];
}

async function valueWithin(factory, timeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeout);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function serviceReadinessTimedOut(deadline, allReady, now = Date.now()) {
  return Number.isFinite(deadline) && now >= deadline && !allReady;
}

function managedServiceReadinessTimedOut({
  allReady = false,
  hasServices = false,
  managed = false,
  now = Date.now(),
  readinessDeadline,
  sharedState
} = {}) {
  if (!hasServices || !managed || allReady) {
    return false;
  }
  return ['running', 'not-responding'].includes(sharedState)
    || serviceReadinessTimedOut(readinessDeadline, allReady, now);
}

function serviceReadinessDetails(services, openPorts, respondingPorts, webPorts) {
  const open = new Set(openPorts || []);
  const responding = new Set(respondingPorts || []);
  const web = new Set(webPorts || []);
  const details = {
    ready: [],
    waiting: [],
    notResponding: []
  };

  for (const service of services || []) {
    const item = { name: service.name, port: service.port };
    if (!open.has(service.port)) {
      details.waiting.push(item);
    } else if (web.has(service.port) && !responding.has(service.port)) {
      details.notResponding.push(item);
    } else {
      details.ready.push(item);
    }
  }

  return details;
}

function serviceTimelineStages({
  services = [],
  commandLaunched = false,
  openPorts = [],
  respondingPorts = [],
  webPorts = [],
  failed = false,
  attention = false
} = {}) {
  const open = new Set(openPorts || []);
  const responding = new Set(respondingPorts || []);
  const web = new Set(webPorts || []);
  const stages = [{
    key: 'command',
    kind: 'command',
    label: 'Launch command',
    state: commandLaunched ? 'complete' : 'pending'
  }];

  for (const service of services || []) {
    const portOpen = open.has(service.port);
    stages.push({
      key: `port-${service.port}`,
      kind: 'port',
      label: `${service.name} :${service.port} available`,
      name: service.name,
      port: service.port,
      state: portOpen ? 'complete' : 'pending'
    });
    if (web.has(service.port)) {
      stages.push({
        key: `response-${service.port}`,
        kind: 'response',
        label: `${service.name} responding`,
        name: service.name,
        port: service.port,
        state: responding.has(service.port) ? 'complete' : 'pending'
      });
    }
  }

  if (failed) {
    const incomplete = stages.find((stage) => stage.state !== 'complete');
    if (incomplete) {
      incomplete.state = 'failed';
    } else {
      stages.push({
        key: 'process-exit',
        kind: 'process',
        label: 'Process exited',
        state: 'failed'
      });
    }
  } else {
    const current = stages.find((stage) => stage.state !== 'complete');
    if (current) {
      current.state = attention ? 'attention' : 'current';
    }
  }

  return stages;
}

function isPrimaryServiceOpen(services, openPorts) {
  const primaryPort = services?.[0]?.port;
  return Number.isInteger(primaryPort) && (openPorts || []).includes(primaryPort);
}

function isPrimaryServiceResponding(services, openPorts, respondingPorts) {
  if (!isPrimaryServiceOpen(services, openPorts)) {
    return false;
  }
  const primary = services?.[0];
  return serviceHealthCheck(primary).mode !== 'http'
    || (respondingPorts || []).includes(primary.port);
}

function projectStatus({
  ambiguousConflict = false,
  allOpen = false,
  anyOpen = false,
  hasServices = false,
  knownConflict = false,
  managed = false,
  ownerAvailable,
  partialPortConflict = false,
  httpUnresponsive = false,
  processActive = false,
  readinessTimedOut = false,
  stopping = false,
}) {
  if (stopping) {
    return 'stopping';
  }
  if (managed && processActive && ownerAvailable === false) {
    return 'ownership-lost';
  }
  if (!hasServices) {
    return processActive ? 'running' : 'stopped';
  }
  if (allOpen) {
    if (!managed && knownConflict) {
      return 'port-in-use';
    }
    if (!managed && ambiguousConflict) {
      return 'port-in-use-unknown';
    }
    if (managed && httpUnresponsive) {
      return readinessTimedOut ? 'not-responding' : 'starting';
    }
    return managed ? 'running' : 'active';
  }
  if (anyOpen) {
    if (managed) {
      return readinessTimedOut ? 'not-ready' : 'starting';
    }
    if (knownConflict) {
      return 'port-in-use';
    }
    if (ambiguousConflict) {
      return 'port-in-use-unknown';
    }
    return partialPortConflict ? 'port-in-use-unknown' : 'active';
  }
  if (managed) {
    return readinessTimedOut ? 'not-ready' : 'starting';
  }
  return 'stopped';
}

function primaryServiceUrl(services) {
  return serviceUrl(services?.[0]);
}

function stoppableProjectIds(projects) {
  return (projects || [])
    .filter((project) => !project.reviewRequired
      && (['running', 'starting', 'not-ready', 'not-responding'].includes(project.status)
        || (['active', 'ownership-lost'].includes(project.status) && Boolean(project.stopCommand))))
    .map((project) => project.id);
}

function runningAppProjectIds(projects) {
  return (projects || [])
    .filter((project) => !project.reviewRequired
      && (project.status === 'running'
        || (project.status === 'active' && !project.httpUnresponsive)))
    .map((project) => project.id);
}

function managedRuntimeProjectIds({
  detachedProjectIds = [],
  localProcessIds = [],
  processRuntime = new Map(),
  startAttemptIds = []
} = {}) {
  return new Set([
    ...detachedProjectIds,
    ...localProcessIds,
    ...processRuntime.keys(),
    ...startAttemptIds
  ]);
}

function reconcileDetachedProjectIds(detachedProjectIds = [], processRuntime = new Map(), portRuntime = new Map()) {
  const reconciled = new Set(detachedProjectIds);
  for (const id of reconciled) {
    if (!processRuntime.has(id) && !portRuntime.has(id)) {
      reconciled.delete(id);
    }
  }
  return reconciled;
}

function hasUnownedPortReservation(projectId, {
  localProcessIds = [],
  portRuntime = new Map(),
  processRuntime = new Map()
} = {}) {
  return portRuntime.has(projectId)
    && !new Set(localProcessIds).has(projectId)
    && !processRuntime.has(projectId);
}

function projectServicesLocked(status, unownedPortReservation = false) {
  return unownedPortReservation || [
    'running',
    'starting',
    'not-ready',
    'not-responding',
    'ownership-lost',
    'stopping'
  ].includes(status);
}

module.exports = {
  areServicesRunning,
  hasUnownedPortReservation,
  httpServiceUrl,
  serviceHealthCheck,
  isPortOpen,
  isPrimaryServiceOpen,
  isPrimaryServiceResponding,
  managedRuntimeProjectIds,
  primaryServiceUrl,
  probeHttpService,
  projectServicesLocked,
  projectStatus,
  reconcileDetachedProjectIds,
  reachableServiceUrls,
  runningAppProjectIds,
  serviceUrl,
  serviceHttpStatus,
  serviceReadinessDetails,
  managedServiceReadinessTimedOut,
  serviceTimelineStages,
  serviceReadinessTimedOut,
  servicePortStatus,
  servicePortHosts,
  stoppableProjectIds
};
