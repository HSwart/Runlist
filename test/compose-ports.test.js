const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildComposeImportProposal } = require('../src/compose/compose-parse');
const {
  normalizePortOverrides,
  projectLaunchEnvironment,
  projectWithPortOverrides
} = require('../src/ports/service-port-overrides');

const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const overrides = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'ports', 'service-port-overrides.js'),
  'utf8'
);

test('Compose published host ports become Runlist services for the port chip', () => {
  const proposal = buildComposeImportProposal({
    folder: '/tmp/ports-app',
    projectName: 'Ports App',
    composePath: '/tmp/ports-app/compose.yaml',
    contents: `
services:
  web:
    ports:
      - "4310:80"
  api:
    ports:
      - target: 3000
        published: 7071
  worker:
    image: busybox
`
  });
  assert.deepEqual(proposal.proposedProject.services, [
    { name: 'web', port: '4310', url: '' },
    { name: 'api', port: '7071', url: '' }
  ]);
  assert.match(webview, /project-port-chip/);
  assert.match(webview, /data-action="open"/);
});

test('temporary port overrides do not rewrite the Compose file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-ports-'));
  const composePath = path.join(root, 'compose.yaml');
  const original = `services:\n  web:\n    ports:\n      - "4310:80"\n`;
  fs.writeFileSync(composePath, original);
  const project = {
    id: 'compose-ports',
    name: 'Compose Ports',
    folder: root,
    composePath,
    startCommand: 'docker compose up web',
    stopCommand: 'docker compose stop web',
    services: [{ name: 'web', port: 4310, url: '' }],
    reviewRequired: false
  };
  const portOverrides = normalizePortOverrides(project, [{
    serviceName: 'web',
    savedPort: 4310,
    port: 5555,
    variable: 'PORT'
  }]);
  const launched = projectWithPortOverrides(project, portOverrides);
  assert.equal(launched.services[0].port, 5555);
  assert.equal(project.services[0].port, 4310);
  assert.equal(fs.readFileSync(composePath, 'utf8'), original);
  const env = projectLaunchEnvironment({ PATH: '/usr/bin' }, portOverrides);
  assert.equal(env.PORT, '5555');
  assert.doesNotMatch(overrides, /writeFileSync\([^)]*compose|fs\.writeFile/);
});

test('Compose rows share native port conflict and open-chip host paths', () => {
  const host = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
    'utf8'
  );
  assert.match(host, /occupiedPortConflict\(/);
  assert.match(host, /servicePortStatus\(/);
  assert.match(host, /forceCloseProjectPorts/);
  assert.doesNotMatch(host, /rewriteCompose|writeComposeFile|editCompose/);
});
