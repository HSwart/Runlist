const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildComposeStartCommand,
  buildComposeStopCommand,
  composeLaunchCommands,
  composeProcessArgv,
  isComposeManagedProject,
  probeComposeAvailability,
  quoteShellArg,
  resolveDockerCli,
  serviceNamesFromComposeCommand,
  withDockerCliPath
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
        assert.match(String(command), /(^|[/\\])docker(\.exe)?$/i);
        assert.deepEqual(args, ['compose', 'version']);
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
  assert.match(
    host,
    /if \(!availability\.ok\) \{[\s\S]*this\.projectOutputs\.set\(id, ''\);[\s\S]*this\.projectFailureSummaries\.delete\(id\);[\s\S]*this\.projectFailureDetails\.delete\(id\);[\s\S]*this\.showStartFailure\(project, \{ detail: availability\.message \}\)/
  );
  assert.match(host, /composeProcessArgv\(launchProject, 'up'/);
  assert.match(host, /composeProcessArgv\(project, 'stop'/);
  assert.match(host, /withDockerCliPath\(/);
  assert.match(processSource, /ownershipKind: 'compose'/);
  assert.match(processSource, /composePath:/);
  assert.match(processSource, /composeServices:/);
  assert.doesNotMatch(host, /docker kill|docker rm -f/);
});

test('Compose-managed Stop skips the custom Stop confirmation modal', () => {
  assert.match(
    host,
    /isComposeManagedProject\(stopProject\)\s*\|\|\s*await this\.confirmCustomStopCommand\(stopProject\)/
  );
});

test('quoteShellArg handles spaces and quotes on all platforms', () => {
  const previous = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  try {
    const unix = quoteShellArg('/tmp/my project/compose.yaml');
    assert.match(unix, /'\/tmp\/my project\/compose\.yaml'/);
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: previous });
  }

  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  try {
    const windows = quoteShellArg('C:\\apps\\my project\\compose.yaml');
    assert.match(windows, /^"/);
    assert.match(windows, /compose\.yaml"$/);
    assert.doesNotMatch(windows, /\\\\"/);
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: previous });
  }
});

test('Windows Compose shell quoting escapes backslashes before quotes', () => {
  const runtime = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'compose', 'compose-runtime.js'),
    'utf8'
  );
  const quote = runtime.slice(
    runtime.indexOf('function quoteShellArg'),
    runtime.indexOf('function unavailable')
  );
  assert.match(quote, /replace\(\/\\\\\/g/);
  assert.match(quote, /replace\(\/"\/g/);
  assert.ok(
    quote.indexOf("replace(/\\\\/g") < quote.indexOf('replace(/"/g'),
    'backslash escape must run before quote escape'
  );
});

test('resolveDockerCli finds Docker Desktop when PATH does not include docker', () => {
  const darwin = resolveDockerCli({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: '/Users/ada' },
    fs: {
      existsSync: (candidate) => candidate === '/usr/local/bin/docker',
      statSync: () => ({ isFile: () => true })
    }
  });
  assert.equal(darwin, '/usr/local/bin/docker');

  const windows = resolveDockerCli({
    platform: 'win32',
    env: {
      Path: 'C:\\Windows\\System32',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local'
    },
    fs: {
      existsSync: (candidate) => (
        candidate === 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
      ),
      statSync: () => ({ isFile: () => true })
    }
  });
  assert.equal(
    windows,
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
  );
});

test('withDockerCliPath prepends Docker Desktop directories for GUI PATH', () => {
  const darwin = withDockerCliPath(
    { PATH: '/usr/bin:/bin', HOME: '/Users/ada' },
    {
      platform: 'darwin',
      dockerCommand: '/usr/local/bin/docker'
    }
  );
  assert.match(darwin.PATH, /^\/usr\/local\/bin:/);
  assert.match(darwin.PATH, /\/Applications\/Docker\.app\/Contents\/Resources\/bin/);

  const windows = withDockerCliPath(
    { Path: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' },
    {
      platform: 'win32',
      dockerCommand: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    }
  );
  assert.match(
    windows.Path,
    /^C:\\Program Files\\Docker\\Docker\\resources\\bin;/
  );
});

test('composeProcessArgv spawns docker compose without shell quoting', () => {
  const composePath = '/tmp/my stack/compose.yaml';
  const project = {
    composePath,
    services: [{ name: 'web', port: 4310 }]
  };
  const argv = composeProcessArgv(project, 'up', {
    dockerCommand: '/usr/local/bin/docker'
  });
  assert.deepEqual(argv, {
    file: '/usr/local/bin/docker',
    args: ['compose', '-f', path.resolve(composePath), 'up', 'web']
  });
  assert.equal(argv.args[2].includes(' '), true);
  const stop = composeProcessArgv(project, 'stop', {
    dockerCommand: '/usr/local/bin/docker'
  });
  assert.deepEqual(stop, {
    file: '/usr/local/bin/docker',
    args: ['compose', '-f', path.resolve(composePath), 'stop', 'web']
  });
});
