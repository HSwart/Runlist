const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Runtime helpers for Compose-managed Runlist projects.
 * Never kills containers by guessed names; commands stay scoped to reviewed services + compose file.
 */

function isComposeManagedProject(project = {}) {
  return typeof project?.composePath === 'string' && Boolean(project.composePath.trim());
}

function composeServiceNames(project = {}) {
  if (Array.isArray(project.composeServices) && project.composeServices.length) {
    return uniqueNames(project.composeServices);
  }
  const fromCommand = serviceNamesFromComposeCommand(project.startCommand)
    || serviceNamesFromComposeCommand(project.stopCommand);
  if (fromCommand.length) {
    return fromCommand;
  }
  const fromServices = (Array.isArray(project.services) ? project.services : [])
    .map((service) => {
      if (typeof service?.composeService === 'string' && service.composeService.trim()) {
        return service.composeService.trim();
      }
      if (typeof service?.name === 'string' && service.name.trim()) {
        return service.name.split(':')[0].trim();
      }
      return '';
    })
    .filter(Boolean);
  return uniqueNames(fromServices);
}

function buildComposeStartCommand(project = {}) {
  return buildComposeCommand(project, 'up');
}

function buildComposeStopCommand(project = {}) {
  return buildComposeCommand(project, 'stop');
}

function composeLaunchCommands(project = {}) {
  if (!isComposeManagedProject(project)) {
    return undefined;
  }
  return {
    startCommand: buildComposeStartCommand(project),
    stopCommand: buildComposeStopCommand(project),
    composePath: path.resolve(project.composePath.trim()),
    composeServices: composeServiceNames(project),
    ownershipKind: 'compose'
  };
}

function buildComposeCommand(project, action) {
  const argv = composeProcessArgv(project, action, { dockerCommand: 'docker' });
  const composeFile = quoteShellArg(argv.args[2]);
  const services = argv.args.slice(4).map(quoteShellArg).join(' ');
  return services
    ? `docker compose -f ${composeFile} ${action} ${services}`
    : `docker compose -f ${composeFile} ${action}`;
}

/**
 * Argv form used to spawn Compose without a shell so macOS/Windows paths
 * with spaces match Linux.
 */
function composeProcessArgv(project = {}, action, options = {}) {
  const composePath = typeof project.composePath === 'string' ? project.composePath.trim() : '';
  if (!composePath) {
    throw new Error('Compose path is required to build a Compose command.');
  }
  if (action !== 'up' && action !== 'stop') {
    throw new Error('Compose action must be up or stop.');
  }
  const services = composeServiceNames(project);
  const docker = options.dockerCommand || resolveDockerCli(options);
  return {
    file: docker,
    args: ['compose', '-f', path.resolve(composePath), action, ...services]
  };
}

/**
 * Fail-closed Docker + Compose v2 probe. Does not start services.
 */
async function probeComposeAvailability(options = {}) {
  const run = options.execFileAsync || execFileAsync;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const env = withDockerCliPath(options.env || process.env, options);
  const docker = options.dockerCommand || resolveDockerCli({ ...options, env });
  try {
    const version = await run(docker, ['compose', 'version'], {
      timeout,
      windowsHide: true,
      env
    });
    const versionText = `${version.stdout || ''}${version.stderr || ''}`;
    if (!/compose|v?2\./i.test(versionText) && !String(version.stdout || '').trim()) {
      return unavailable(
        'COMPOSE_MISSING',
        'Docker Compose is not available. Install Compose v2, then try again.'
      );
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return unavailable(
        'DOCKER_MISSING',
        'Docker is not available. Install Docker Desktop or Engine, then try again.'
      );
    }
    if (isTimeout(error)) {
      return unavailable(
        'DOCKER_TIMEOUT',
        'Docker did not respond in time. Check that Docker is running, then try again.'
      );
    }
    return unavailable(
      'COMPOSE_MISSING',
      plainDockerError(
        error,
        'Docker Compose is not available. Install Compose v2, then try again.'
      )
    );
  }

  try {
    await run(docker, ['info'], {
      timeout,
      windowsHide: true,
      env
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return unavailable(
        'DOCKER_MISSING',
        'Docker is not available. Install Docker Desktop or Engine, then try again.'
      );
    }
    if (isTimeout(error)) {
      return unavailable(
        'DOCKER_TIMEOUT',
        'Docker did not respond in time. Check that Docker is running, then try again.'
      );
    }
    return unavailable(
      'DOCKER_UNAVAILABLE',
      plainDockerError(
        error,
        'Docker is not running. Start Docker, then try again.'
      )
    );
  }

  return { ok: true };
}

function serviceNamesFromComposeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return [];
  }
  const match = command.match(/\bdocker\s+compose\b(?:\s+-f\s+\S+)?\s+(?:up|stop|down)\b(.*)$/i);
  if (!match) {
    return [];
  }
  return uniqueNames(
    match[1]
      .trim()
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith('-'))
  );
}

function uniqueNames(values) {
  const seen = new Set();
  const names = [];
  for (const value of values) {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function pathForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function pathDelimiter(platform) {
  return platform === 'win32' ? ';' : ':';
}

function pathEnvironmentKey(env = {}, platform = process.platform) {
  if (platform !== 'win32') {
    return 'PATH';
  }
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
}

function dockerExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'docker.exe' : 'docker';
}

function dockerCliWellKnownDirectories(env = {}, platform = process.platform) {
  const pathApi = pathForPlatform(platform);
  const home = env.HOME || env.USERPROFILE || '';
  if (platform === 'darwin') {
    return [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      home ? pathApi.join(home, '.docker', 'bin') : '',
      '/Applications/Docker.app/Contents/Resources/bin'
    ].filter(Boolean);
  }
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA || '';
    return [
      pathApi.join(programFiles, 'Docker', 'Docker', 'resources', 'bin'),
      pathApi.join(programFilesX86, 'Docker', 'Docker', 'resources', 'bin'),
      localAppData ? pathApi.join(localAppData, 'Docker', 'bin') : ''
    ].filter(Boolean);
  }
  return ['/usr/local/bin', '/usr/bin'];
}

function dockerSearchDirectories(env = {}, platform = process.platform) {
  const key = pathEnvironmentKey(env, platform);
  const current = env[key] || '';
  return [
    ...current.split(pathDelimiter(platform)).filter(Boolean),
    ...dockerCliWellKnownDirectories(env, platform)
  ];
}

function resolveDockerCli(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const fsApi = options.fs || fs;
  const pathApi = pathForPlatform(platform);
  const name = dockerExecutableName(platform);
  const seen = new Set();
  for (const dir of dockerSearchDirectories(env, platform)) {
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    const candidate = pathApi.join(dir, name);
    try {
      if (!fsApi.existsSync(candidate)) {
        continue;
      }
      const stat = typeof fsApi.statSync === 'function' ? fsApi.statSync(candidate) : undefined;
      if (stat && typeof stat.isFile === 'function' && !stat.isFile()) {
        continue;
      }
      return candidate;
    } catch {
      // Keep looking through PATH and Docker Desktop locations.
    }
  }
  return name;
}

function withDockerCliPath(env = {}, options = {}) {
  const platform = options.platform || process.platform;
  const merged = { ...env };
  const key = pathEnvironmentKey(merged, platform);
  const delimiter = pathDelimiter(platform);
  const current = merged[key] || '';
  const currentDirs = new Set(
    current.split(delimiter).filter(Boolean).map((dir) => (
      platform === 'win32' ? dir.toLowerCase() : dir
    ))
  );
  const extra = [];
  const docker = options.dockerCommand || resolveDockerCli({ ...options, env: merged });
  if (pathForPlatform(platform).isAbsolute(docker)) {
    extra.push(pathForPlatform(platform).dirname(docker));
  }
  extra.push(...dockerCliWellKnownDirectories(merged, platform));
  const prefix = [];
  for (const dir of extra) {
    const keyDir = platform === 'win32' ? dir.toLowerCase() : dir;
    if (!dir || currentDirs.has(keyDir) || prefix.some((item) => (
      platform === 'win32' ? item.toLowerCase() === keyDir : item === dir
    ))) {
      continue;
    }
    prefix.push(dir);
  }
  if (!prefix.length) {
    return merged;
  }
  merged[key] = current ? `${prefix.join(delimiter)}${delimiter}${current}` : prefix.join(delimiter);
  return merged;
}

function quoteShellArg(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    if (!/[\s"]/u.test(text)) {
      return text;
    }
    // Escape backslashes first so \" stays a literal quote inside the double-quoted arg.
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (!/[^\w@%+=:,./-]/u.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function unavailable(code, message) {
  return { ok: false, code, message };
}

function isTimeout(error) {
  return error?.killed === true || error?.code === 'ETIMEDOUT' || /ETIMEDOUT/i.test(error?.message || '');
}

function plainDockerError(error, fallback) {
  const detail = String(error?.stderr || error?.message || '').trim();
  if (/permission denied|cannot connect|Is the docker daemon running/i.test(detail)) {
    return 'Docker is not running. Start Docker, then try again.';
  }
  if (/compose/i.test(detail) && /not found|unknown/i.test(detail)) {
    return 'Docker Compose is not available. Install Compose v2, then try again.';
  }
  return fallback;
}

module.exports = {
  buildComposeStartCommand,
  buildComposeStopCommand,
  composeLaunchCommands,
  composeProcessArgv,
  composeServiceNames,
  isComposeManagedProject,
  probeComposeAvailability,
  quoteShellArg,
  resolveDockerCli,
  serviceNamesFromComposeCommand,
  withDockerCliPath
};
