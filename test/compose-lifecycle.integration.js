const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { before } = test;
const { detectComposeFiles, readComposeFile, resolveComposeFile } = require('../src/compose/compose-file');
const { buildComposeImportProposal } = require('../src/compose/compose-parse');
const {
  buildComposeStartCommand,
  buildComposeStopCommand,
  composeLaunchCommands,
  composeServiceNames,
  probeComposeAvailability
} = require('../src/compose/compose-runtime');
const {
  composeDown,
  createComposeWorkspace,
  createProbeExecFileAsync,
  dockerRuntimeAvailable,
  reserveLocalPort,
  runComposeUpAttached,
  runDocker,
  runComposeCommand,
  waitForTcpPort,
  waitForTcpPortClosed,
  withComposeProjectName,
  writeComposeFixture
} = require('./helpers/docker-compose-harness');

const dockerIntegrationPlatform = process.platform === 'linux';

let dockerReady;

before(async () => {
  dockerReady = dockerIntegrationPlatform && await dockerRuntimeAvailable();
});

function testIfDocker(name, fn, options) {
  test(name, options, async (t) => {
    if (!dockerIntegrationPlatform) {
      t.skip('Docker Compose integration runs on Linux CI only');
      return;
    }
    if (!dockerReady) {
      t.skip('Docker runtime unavailable');
      return;
    }
    return fn(t);
  });
}

testIfDocker('probeComposeAvailability passes against a live Docker daemon', async () => {
  const execFileAsync = await createProbeExecFileAsync();
  assert.ok(execFileAsync, 'Docker invoker required for probe test');
  const result = await probeComposeAvailability({
    timeoutMs: 15_000,
    execFileAsync
  });
  assert.equal(result.ok, true);
});

testIfDocker('full lifecycle: detect → import → up → port ready → scoped stop → ports closed', async (t) => {
  const workspace = createComposeWorkspace();
  t.after(async () => {
    await composeDown(workspace.composePath, workspace.projectName);
    workspace.cleanup();
  });

  const webPort = await reserveLocalPort();
  const cachePort = await reserveLocalPort();
  workspace.projectName = `runlist-lifecycle-${process.pid}-${Date.now()}`;

  await writeComposeFixture(workspace, `
  web:
    image: nginx:alpine
    ports:
      - "${webPort}:80"
  cache:
    image: redis:alpine
    ports:
      - "${cachePort}:6379"
  db:
    image: alpine:3.20
    command: sleep 3600
`);

  const detected = detectComposeFiles(workspace.root);
  assert.equal(path.basename(detected[0]), 'compose.yaml');
  assert.equal(resolveComposeFile(workspace.root), workspace.composePath);

  const file = readComposeFile(workspace.composePath);
  const proposal = buildComposeImportProposal({
    folder: workspace.root,
    composePath: file.path,
    contents: file.contents
  });
  assert.equal(proposal.proposedProject.composePath, workspace.composePath);
  assert.deepEqual(
    proposal.proposedProject.services.map((service) => service.name),
    ['web', 'cache']
  );
  assert.match(proposal.warnings.join(' '), /db has no published host port/i);

  const project = proposal.proposedProject;
  const launch = composeLaunchCommands(project);
  assert.equal(launch.ownershipKind, 'compose');
  assert.deepEqual(launch.composeServices, ['web', 'cache', 'db']);
  assert.doesNotMatch(launch.startCommand, /-d\b/);

  const startCommand = withComposeProjectName(launch.startCommand, workspace.projectName);
  const stopCommand = withComposeProjectName(launch.stopCommand, workspace.projectName);

  await composeDown(workspace.composePath, workspace.projectName);

  const session = await runComposeUpAttached(startCommand, { cwd: workspace.root });
  t.after(async () => {
    await session.stop();
  });

  assert.equal(await waitForTcpPort(webPort, { timeoutMs: 60_000 }), true);
  assert.equal(await waitForTcpPort(cachePort, { timeoutMs: 60_000 }), true);

  await runComposeCommand(stopCommand, { cwd: workspace.root, timeoutMs: 60_000 });

  assert.equal(await waitForTcpPortClosed(webPort, { timeoutMs: 30_000 }), true);
  assert.equal(await waitForTcpPortClosed(cachePort, { timeoutMs: 30_000 }), true);

  const exitCode = await session.waitForExit(30_000);
  assert.ok(exitCode === 0 || exitCode === null || exitCode === 130);
});

testIfDocker('scoped stop leaves unrelated compose services running', async (t) => {
  const workspace = createComposeWorkspace();
  t.after(async () => {
    await composeDown(workspace.composePath, workspace.projectName);
    workspace.cleanup();
  });

  const webPort = await reserveLocalPort();
  workspace.projectName = `runlist-scope-${process.pid}-${Date.now()}`;

  await writeComposeFixture(workspace, `
  web:
    image: nginx:alpine
    ports:
      - "${webPort}:80"
  worker:
    image: alpine:3.20
    command: sleep 3600
`);

  const proposal = buildComposeImportProposal({
    folder: workspace.root,
    composePath: workspace.composePath,
    contents: fs.readFileSync(workspace.composePath, 'utf8')
  });
  const startProject = proposal.proposedProject;
  const stopProject = {
    ...proposal.proposedProject,
    composeServices: ['web']
  };
  const startCommand = withComposeProjectName(
    buildComposeStartCommand(startProject),
    workspace.projectName
  );
  const stopCommand = withComposeProjectName(
    buildComposeStopCommand(stopProject),
    workspace.projectName
  );

  await composeDown(workspace.composePath, workspace.projectName);
  const session = await runComposeUpAttached(startCommand, { cwd: workspace.root });
  t.after(async () => {
    await session.stop();
  });
  assert.equal(await waitForTcpPort(webPort, { timeoutMs: 60_000 }), true);

  await runComposeCommand(stopCommand, { cwd: workspace.root, timeoutMs: 60_000 });
  assert.equal(await waitForTcpPortClosed(webPort, { timeoutMs: 30_000 }), true);

  const running = await runDocker([
    'compose',
    '-f',
    workspace.composePath,
    '-p',
    workspace.projectName,
    'ps',
    '--status',
    'running',
    '--format',
    '{{.Service}}'
  ], { cwd: workspace.root, timeoutMs: 30_000 });
  assert.deepEqual(composeServiceNames(stopProject), ['web']);
  assert.deepEqual(composeServiceNames(startProject), ['web', 'worker']);
  assert.match(running, /worker/i);
  assert.doesNotMatch(running, /\bweb\b/i);
});

testIfDocker('paths with spaces stay scoped in compose commands', async (t) => {
  const parent = createComposeWorkspace('runlist-compose-space-');
  const folderWithSpaces = path.join(parent.root, 'my stack');
  fs.mkdirSync(folderWithSpaces, { recursive: true });
  const composePath = path.join(folderWithSpaces, 'compose.yaml');
  const webPort = await reserveLocalPort();
  parent.projectName = `runlist-space-${process.pid}-${Date.now()}`;

  fs.writeFileSync(composePath, `
services:
  web:
    image: nginx:alpine
    ports:
      - "${webPort}:80"
`.trimStart(), 'utf8');

  t.after(async () => {
    await composeDown(composePath, parent.projectName);
    parent.cleanup();
  });

  const proposal = buildComposeImportProposal({
    folder: folderWithSpaces,
    composePath,
    contents: fs.readFileSync(composePath, 'utf8')
  });
  const launch = composeLaunchCommands(proposal.proposedProject);
  assert.match(launch.startCommand, /-f .+my stack.+compose\.yaml['"]? up web/);
  assert.match(launch.stopCommand, /-f .+my stack.+compose\.yaml['"]? stop web/);

  const startCommand = withComposeProjectName(launch.startCommand, parent.projectName);
  const stopCommand = withComposeProjectName(launch.stopCommand, parent.projectName);
  await composeDown(composePath, parent.projectName);

  const session = await runComposeUpAttached(startCommand, { cwd: folderWithSpaces });
  t.after(async () => {
    await session.stop();
  });

  assert.equal(await waitForTcpPort(webPort, { timeoutMs: 60_000 }), true);
  await runComposeCommand(stopCommand, { cwd: folderWithSpaces, timeoutMs: 60_000 });
  assert.equal(await waitForTcpPortClosed(webPort, { timeoutMs: 30_000 }), true);
});

testIfDocker('compose.yml and docker-compose.yml are both detected', async (t) => {
  const workspace = createComposeWorkspace('runlist-compose-detect-');
  t.after(() => workspace.cleanup());

  fs.writeFileSync(path.join(workspace.root, 'docker-compose.yml'), 'services:\n  legacy:\n    image: alpine:3.20\n');
  fs.writeFileSync(path.join(workspace.root, 'compose.yml'), `
services:
  current:
    image: nginx:alpine
    ports:
      - "18080:80"
`.trimStart(), 'utf8');

  assert.deepEqual(
    detectComposeFiles(workspace.root).map((file) => path.basename(file)),
    ['compose.yml', 'docker-compose.yml']
  );
  assert.equal(path.basename(resolveComposeFile(workspace.root)), 'compose.yml');
});

test('docker integration tests skip cleanly when Docker runtime is unavailable', async () => {
  if (!dockerIntegrationPlatform) {
    assert.equal(dockerReady, false);
    return;
  }
  if (dockerReady) {
    assert.equal(await dockerRuntimeAvailable(), true);
    return;
  }
  assert.equal(process.env.RUNLIST_SKIP_DOCKER_INTEGRATION === '1' || !dockerReady, true);
});
