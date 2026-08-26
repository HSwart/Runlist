const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildComposeStartCommand,
  buildComposeStopCommand,
  composeLaunchCommands,
  isComposeManagedProject,
  probeComposeAvailability,
  serviceNamesFromComposeCommand
} = require('../src/compose/compose-runtime');

const host = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
  'utf8'
);
const processSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lifecycle', 'project-process.js'),
  'utf8'
);

test('detects Compose-managed projects and builds -f scoped up/stop commands', () => {
  const project = {
    composePath: '/tmp/acme/compose.yaml',
    startCommand: 'docker compose up web api',
    stopCommand: 'docker compose stop web api',
    services: [
      { name: 'web', port: 4310 },
      { name: 'api', port: 7071 }
    ]
  };
  assert.equal(isComposeManagedProject(project), true);
  assert.equal(isComposeManagedProject({ startCommand: 'npm start' }), false);
  assert.deepEqual(serviceNamesFromComposeCommand(project.startCommand), ['web', 'api']);
  assert.match(buildComposeStartCommand(project), /docker compose -f .*compose\.yaml up web api/);
  assert.match(buildComposeStopCommand(project), /docker compose -f .*compose\.yaml stop web api/);
  const launch = composeLaunchCommands(project);
  assert.equal(launch.ownershipKind, 'compose');
  assert.deepEqual(launch.composeServices, ['web', 'api']);
  assert.doesNotMatch(launch.startCommand, /docker kill|docker rm/);
});

test('probeComposeAvailability fails closed when Docker is missing', async () => {
  const result = await probeComposeAvailability({
    execFileAsync: async () => {
      const error = new Error('spawn docker ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DOCKER_MISSING');
  assert.match(result.message, /Docker is not available/i);
});

test('probeComposeAvailability fails closed when the daemon is down', async () => {
  let call = 0;
  const result = await probeComposeAvailability({
    execFileAsync: async (command, args) => {
      call += 1;
      if (call === 1) {
        assert.deepEqual([command, ...args], ['docker', 'compose', 'version']);
        return { stdout: 'Docker Compose version v2.29.0\n', stderr: '' };
      }
      const error = new Error('Cannot connect to the Docker daemon');
      error.stderr = 'Cannot connect to the Docker daemon';
      throw error;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DOCKER_UNAVAILABLE');
  assert.match(result.message, /Docker is not running/i);
});

test('probeComposeAvailability passes when Compose v2 and the daemon respond', async () => {
  const result = await probeComposeAvailability({
    execFileAsync: async () => ({ stdout: 'ok\n', stderr: '' })
  });
  assert.equal(result.ok, true);
});

test('host Start probes Compose availability and records Compose ownership fields', () => {
  assert.match(host, /probeComposeAvailability\(/);
  assert.match(host, /composeLaunchCommands\(/);
  assert.match(host, /ownershipKind: 'compose'/);
  assert.match(host, /composeServices: composeLaunch\.composeServices/);
  assert.match(processSource, /ownershipKind: 'compose'/);
  assert.match(processSource, /composePath:/);
  assert.match(processSource, /composeServices:/);
  assert.doesNotMatch(host, /docker kill|docker rm -f/);
});
