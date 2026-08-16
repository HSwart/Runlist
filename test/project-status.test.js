const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const {
  areServicesRunning,
  httpServiceUrl,
  isPortOpen,
  isPrimaryServiceOpen,
  isPrimaryServiceResponding,
  primaryServiceUrl,
  probeHttpService,
  projectStatus,
  reachableServiceUrls,
  serviceUrl,
  serviceHttpStatus,
  serviceReadinessDetails,
  serviceReadinessTimedOut,
  servicePortStatus,
  stoppableProjectIds
} = require('../project-status');

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve) => server.listen(0, host, resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('detects whether configured local service ports are accepting connections', async () => {
  const server = net.createServer();
  const port = await listen(server);

  assert.equal(await isPortOpen(port), true);
  assert.equal(await areServicesRunning([{ name: 'web', port }]), true);
  assert.deepEqual(await servicePortStatus([{ name: 'web', port }]), {
    allOpen: true,
    anyOpen: true,
    openPorts: [port]
  });

  await close(server);
  assert.equal(await isPortOpen(port), false);
});

test('counts redirects, authentication challenges, and HTTP errors as responses', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(Number(request.url.slice(1)) || 200, { location: '/login' });
    response.end();
  });
  t.after(() => close(server));
  const port = await listen(server);

  for (const status of [200, 302, 401, 500]) {
    assert.equal(await probeHttpService(`http://127.0.0.1:${port}/${status}`), true);
  }
});

test('times out when a port accepts connections without returning HTTP', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(server);
  });
  const port = await listen(server);

  assert.equal(await probeHttpService(`http://127.0.0.1:${port}`, { timeout: 30 }), false);
});

test('checks only services with explicit web URLs and supports URI forwarding', async () => {
  const seen = [];
  const status = await serviceHttpStatus([
    { name: 'web', port: 4310, url: 'http://localhost:4310/health' },
    { name: 'database', port: 5432 }
  ], [4310, 5432], {
    resolveUrl: async (url) => url.replace('localhost', '127.0.0.1'),
    probe: async (url) => {
      seen.push(url);
      return true;
    }
  });

  assert.deepEqual(seen, ['http://127.0.0.1:4310/health']);
  assert.deepEqual(status, {
    allResponding: true,
    respondingPorts: [4310],
    unresponsivePorts: [],
    webPorts: [4310]
  });
  assert.equal(httpServiceUrl({ name: 'database', port: 5432 }), undefined);
});

test('reports an open web port that does not return HTTP', async () => {
  const status = await serviceHttpStatus([
    { name: 'web', port: 4310, url: 'http://127.0.0.1:4310' }
  ], [4310], { probe: async () => false });

  assert.deepEqual(status, {
    allResponding: false,
    respondingPorts: [],
    unresponsivePorts: [4310],
    webPorts: [4310]
  });
  assert.equal(httpServiceUrl({
    name: 'secure web',
    port: 443,
    url: 'https://localhost/health'
  }), 'https://localhost/health');
});

test('finds safe reachable URLs for individual open services', async () => {
  const seen = [];
  const reachable = await reachableServiceUrls([
    { name: 'web', port: 4310 },
    { name: 'admin', port: 4311, url: 'https://admin.local/dashboard' },
    { name: 'database', port: 5432 },
    { name: 'unsafe', port: 4312, url: 'file:///tmp/app' }
  ], [4310, 4311, 5432, 4312], {
    resolveUrl: async (url) => url.replace('127.0.0.1', 'localhost'),
    probe: async (url) => {
      seen.push(url);
      return !url.includes('5432');
    }
  });

  assert.deepEqual(seen, [
    'http://localhost:4310',
    'https://admin.local/dashboard'
  ]);
  assert.deepEqual(reachable, [
    { port: 4310, url: 'http://localhost:4310/' },
    { port: 4311, url: 'https://admin.local/dashboard' }
  ]);
  assert.equal(serviceUrl({ name: 'web', port: 4310 }), 'http://127.0.0.1:4310');
  assert.equal(serviceUrl({ name: 'unsafe', port: 4312, url: 'javascript:alert(1)' }), undefined);
});

test('bounds service URL forwarding and reachability checks', async () => {
  const service = [{ name: 'web', port: 4310 }];
  const startedAt = Date.now();
  const unresolvedForward = await reachableServiceUrls(service, [4310], {
    resolveUrl: () => new Promise(() => {}),
    timeout: 30
  });
  const unresolvedProbe = await reachableServiceUrls(service, [4310], {
    probe: () => new Promise(() => {}),
    timeout: 30
  });

  assert.deepEqual(unresolvedForward, []);
  assert.deepEqual(unresolvedProbe, []);
  assert.ok(Date.now() - startedAt < 250);
});

test('bounds URI forwarding and custom probe work within one timeout', async () => {
  const services = [{ name: 'web', port: 4310, url: 'http://localhost:4310' }];
  const startedAt = Date.now();
  const unresolvedForward = await serviceHttpStatus(services, [4310], {
    resolveUrl: () => new Promise(() => {}),
    timeout: 30
  });
  const unresolvedProbe = await serviceHttpStatus(services, [4310], {
    probe: () => new Promise(() => {}),
    timeout: 30
  });

  assert.deepEqual(unresolvedForward.unresponsivePorts, [4310]);
  assert.deepEqual(unresolvedProbe.unresponsivePorts, [4310]);
  assert.ok(Date.now() - startedAt < 250);
});

test('detects an unmanaged app when all configured service ports are open', () => {
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    managed: false
  }), 'active');
});

test('keeps managed services starting until every configured port is ready', () => {
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    managed: true
  }), 'running');
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    httpUnresponsive: true,
    managed: true
  }), 'starting');
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    httpUnresponsive: true,
    managed: true,
    readinessTimedOut: true
  }), 'not-responding');
  assert.equal(projectStatus({
    allOpen: false,
    anyOpen: true,
    hasServices: true,
    managed: true,
    processActive: true
  }), 'starting');
  assert.equal(projectStatus({
    hasServices: true,
    managed: true,
    processActive: true
  }), 'starting');
  assert.equal(projectStatus({
    hasServices: true,
    managed: true,
    processActive: true,
    readinessTimedOut: true
  }), 'not-ready');
  assert.equal(projectStatus({
    anyOpen: true,
    hasServices: true,
    managed: true,
    readinessTimedOut: true
  }), 'not-ready');
  assert.equal(projectStatus({ hasServices: true }), 'stopped');
  assert.equal(projectStatus({ managed: true, processActive: true }), 'running');
  assert.equal(projectStatus({}), 'stopped');
  assert.equal(projectStatus({ stopping: true }), 'stopping');
});

test('keeps checking after the readiness deadline and becomes running when services are ready', () => {
  assert.equal(projectStatus({
    allOpen: false,
    hasServices: true,
    managed: true,
    processActive: true,
    readinessTimedOut: true
  }), 'not-ready');
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    managed: true,
    processActive: true,
    readinessTimedOut: true
  }), 'running');
});

test('describes ready, waiting, and nonresponding services by name and port', () => {
  const details = serviceReadinessDetails([
    { name: 'web', port: 5173 },
    { name: 'api', port: 4311 },
    { name: 'docs', port: 4173 }
  ], [5173, 4173], [5173], [5173, 4173]);

  assert.deepEqual(details, {
    ready: [{ name: 'web', port: 5173 }],
    waiting: [{ name: 'api', port: 4311 }],
    notResponding: [{ name: 'docs', port: 4173 }]
  });
  assert.deepEqual(serviceReadinessDetails(), {
    ready: [],
    waiting: [],
    notResponding: []
  });
});

test('treats partial unmanaged service availability as active', () => {
  assert.equal(projectStatus({
    allOpen: false,
    anyOpen: true,
    hasServices: true,
    managed: false
  }), 'active');
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    httpUnresponsive: true,
    managed: false
  }), 'active');
});

test('reports known and ambiguous port conflicts from refresh-shaped status', () => {
  assert.equal(projectStatus({
    allOpen: true,
    anyOpen: true,
    hasServices: true,
    knownConflict: true,
    managed: false
  }), 'port-in-use');
  assert.equal(projectStatus({
    allOpen: false,
    anyOpen: true,
    ambiguousConflict: true,
    hasServices: true,
    managed: false
  }), 'port-in-use-unknown');
});

test('uses a bounded TCP readiness deadline', () => {
  assert.equal(serviceReadinessTimedOut(1000, false, 999), false);
  assert.equal(serviceReadinessTimedOut(1000, false, 1000), true);
  assert.equal(serviceReadinessTimedOut(1000, true, 2000), false);
  assert.equal(serviceReadinessTimedOut(undefined, false, 2000), false);
});

test('represents clean exits and no-service projects with process state', () => {
  assert.equal(projectStatus({ hasServices: true, managed: false, processActive: false }), 'stopped');
  assert.equal(projectStatus({ hasServices: false, managed: true, processActive: true }), 'running');
  assert.equal(projectStatus({ hasServices: false, managed: true, processActive: false }), 'stopped');
  assert.equal(projectStatus({ hasServices: false, managed: false, processActive: false }), 'stopped');
});

test('uses a safe primary service URL override or derives localhost from its port', () => {
  assert.equal(primaryServiceUrl([{
    name: 'web',
    port: 8787,
    url: 'https://app.local/dashboard?view=all'
  }]), 'https://app.local/dashboard?view=all');
  assert.equal(primaryServiceUrl([{ name: 'web', port: 8787 }]), 'http://127.0.0.1:8787');
  assert.equal(primaryServiceUrl([{ name: 'web', port: 8787, url: 'file:///tmp/app' }]), undefined);
  assert.equal(primaryServiceUrl([]), undefined);
});

test('opens the primary service only when its own port is ready', () => {
  const services = [
    { name: 'web', port: 8787 },
    { name: 'api', port: 8788 }
  ];
  assert.equal(isPrimaryServiceOpen(services, [8788]), false);
  assert.equal(isPrimaryServiceOpen(services, [8787, 8788]), true);
  assert.equal(isPrimaryServiceOpen([], [8787]), false);
  assert.equal(isPrimaryServiceResponding(services, [8787, 8788], []), true);
  const webServices = [
    { name: 'web', port: 8787, url: 'http://localhost:8787' },
    { name: 'api', port: 8788 }
  ];
  assert.equal(isPrimaryServiceResponding(webServices, [8787, 8788], []), false);
  assert.equal(isPrimaryServiceResponding(webServices, [8787, 8788], [8787]), true);
});

test('uses VS Code URI forwarding for service health and browser opening', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(extension, /vscode\.env\.asExternalUri\(vscode\.Uri\.parse\(url\)\)/);
  assert.match(extension, /serviceHttpStatus\([\s\S]*resolveUrl: \(url\) => this\.externalServiceUrl\(url\)/);
});

test('shows a clear nonresponding state without changing stop safety', () => {
  const root = path.join(__dirname, '..');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(webview, /'not-responding': 'Web service not responding'/);
  assert.match(webview, /project\.httpUnresponsive \? 'Detected, web service not responding' : 'Detected running'/);
  assert.match(webview, /const statusClass = projectStatus === 'active' && project\.httpUnresponsive[\s\S]*\? 'not-responding'[\s\S]*: displayStatus/);
  assert.match(webview, /project-status status-\$\{statusClass\}/);
  assert.match(webview, /\['running', 'starting', 'not-ready', 'not-responding', 'active'\]\.includes\(projectStatus\)/);
  assert.match(webview, /aria-label="\$\{escapeHtml\(service\.name\)\} on port/);
  assert.match(styles, /\.service-indicator\.not-responding/);
});

test('shows slow startup as ongoing service checks rather than a failure', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

  assert.match(webview, /'not-ready': 'Taking longer…'/);
  assert.match(webview, /notReadyCount[\s\S]*taking longer/);
  assert.match(webview, /<strong>Ready:<\/strong>/);
  assert.match(webview, /<strong>Still checking:<\/strong>/);
  assert.match(webview, /<strong>Waiting for web response:<\/strong>/);
  assert.match(webview, /\['starting', 'not-ready', 'stopping'\]\.includes\(projectStatus\)/);
  assert.doesNotMatch(webview, /Service not ready/);
  assert.match(styles, /\.project-readiness-detail[\s\S]*overflow-wrap: anywhere/);
  assert.match(extension, /startup is taking longer than expected\. Still checking/);
  assert.match(extension, /is still running\. Runlist is still checking/);
  assert.match(extension, /formatServiceList\(stillChecking\) \|\| 'the configured services'/);
  assert.match(extension, /ready \? ` Ready: \$\{ready\}\.\` : ''/);
  assert.doesNotMatch(extension, /were not all ready within/);
});

test('selects only projects that can be stopped together', () => {
  const projects = [
    { id: 'running', status: 'running' },
    { id: 'starting', status: 'starting' },
    { id: 'not-ready', status: 'not-ready' },
    { id: 'not-responding', status: 'not-responding' },
    { id: 'detected-without-stop', status: 'active' },
    { id: 'detected-with-custom-stop', status: 'active', stopCommand: 'docker compose down' },
    { id: 'pending-review', status: 'running', reviewRequired: true },
    { id: 'stopping', status: 'stopping' },
    { id: 'stopped', status: 'stopped' },
    { id: 'conflict', status: 'port-in-use' },
    { id: 'unknown-owner', status: 'port-in-use-unknown' }
  ];

  assert.deepEqual(stoppableProjectIds(projects), [
    'running',
    'starting',
    'not-ready',
    'not-responding',
    'detected-with-custom-stop'
  ]);
  assert.deepEqual(stoppableProjectIds(), []);
});
