const { execFile } = require('child_process');
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
  const composePath = typeof project.composePath === 'string' ? project.composePath.trim() : '';
  if (!composePath) {
    throw new Error('Compose path is required to build a Compose command.');
  }
  const services = composeServiceNames(project);
  const fileArg = quoteShellArg(path.resolve(composePath));
  const serviceArgs = services.map(quoteShellArg).join(' ');
  const noDeps = action === 'up' && (project.composeAutoRow === true || project.composeNoDeps === true)
    ? ' --no-deps'
    : '';
  return serviceArgs
    ? `docker compose -f ${fileArg} ${action}${noDeps} ${serviceArgs}`
    : `docker compose -f ${fileArg} ${action}`;
}

/**
 * Fail-closed Docker + Compose v2 probe. Does not start services.
 */
async function probeComposeAvailability(options = {}) {
  const run = options.execFileAsync || execFileAsync;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  try {
    const version = await run('docker', ['compose', 'version'], {
      timeout,
      windowsHide: true
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
    await run('docker', ['info'], {
      timeout,
      windowsHide: true
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
  composeServiceNames,
  isComposeManagedProject,
  probeComposeAvailability,
  quoteShellArg,
  serviceNamesFromComposeCommand
};
