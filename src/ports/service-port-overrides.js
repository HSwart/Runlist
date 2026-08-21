const PORT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_PORT_VARIABLES = new Set([
  'appdata',
  'bash_env',
  'cdpath',
  'comspec',
  'dyld_insert_libraries',
  'dyld_library_path',
  'electron_run_as_node',
  'env',
  'home',
  'ifs',
  'ld_library_path',
  'ld_preload',
  'localappdata',
  'node_extra_ca_certs',
  'node_options',
  'node_path',
  'path',
  'pathext',
  'programdata',
  'programfiles',
  'psmodulepath',
  'shell',
  'shellopts',
  'systemroot',
  'temp',
  'tmp',
  'userprofile',
  'windir',
  'zshenv'
]);

function normalizePortOverrides(project, overrides) {
  if (overrides === undefined || overrides === null) {
    return [];
  }
  if (!Array.isArray(overrides) || overrides.length > (project?.services?.length || 0)) {
    throw new Error('Temporary port settings are not valid for this project.');
  }

  const services = project?.services || [];
  const servicesByName = new Map(services.map((service) => [service.name, service]));
  const seenServices = new Set();
  const seenVariables = new Set();
  const normalized = overrides.map((override) => {
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      throw new Error('Temporary port settings are not valid for this project.');
    }
    const serviceName = String(override.serviceName || '');
    const service = servicesByName.get(serviceName);
    const savedPort = Number(override.savedPort);
    const port = Number(override.port);
    const variable = String(override.variable || '').trim();
    const variableKey = variable.toLocaleLowerCase('en-US');

    if (!service || savedPort !== service.port || seenServices.has(serviceName)) {
      throw new Error('The saved service changed before the temporary port could be applied.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === savedPort) {
      throw new Error('Choose a different whole-number port from 1 to 65535.');
    }
    if (!PORT_VARIABLE_PATTERN.test(variable) || BLOCKED_PORT_VARIABLES.has(variableKey)) {
      throw new Error('Enter a portable, non-system environment variable name.');
    }
    if (seenVariables.has(variableKey)) {
      throw new Error('Use a different environment variable for each temporary port.');
    }

    seenServices.add(serviceName);
    seenVariables.add(variableKey);
    return { serviceName, savedPort, port, variable };
  });

  const overridesByName = new Map(normalized.map((override) => [override.serviceName, override]));
  const effectivePorts = services.map((service) => (
    overridesByName.get(service.name)?.port || service.port
  ));
  if (new Set(effectivePorts).size !== effectivePorts.length) {
    throw new Error('The temporary port must be different from every other project service port.');
  }

  return services.flatMap((service) => {
    const override = overridesByName.get(service.name);
    return override ? [override] : [];
  });
}

function projectWithPortOverrides(project, overrides) {
  const normalized = normalizePortOverrides(project, overrides);
  if (!normalized.length) {
    return project;
  }
  const overridesByName = new Map(normalized.map((override) => [override.serviceName, override]));
  return {
    ...project,
    services: (project.services || []).map((service) => {
      const override = overridesByName.get(service.name);
      if (!override) {
        return service;
      }
      return {
        ...service,
        port: override.port,
        ...(service.url ? { url: rewriteLoopbackServiceUrl(service.url, service.port, override.port) } : {}),
        savedPort: service.port,
        portVariable: override.variable,
        temporaryPort: true
      };
    })
  };
}

function projectLaunchEnvironment(baseEnvironment, overrides) {
  const environment = { ...(baseEnvironment || {}) };
  for (const override of overrides || []) {
    const variable = String(override?.variable || '').trim();
    const port = Number(override?.port);
    if (!PORT_VARIABLE_PATTERN.test(variable)
      || BLOCKED_PORT_VARIABLES.has(variable.toLocaleLowerCase('en-US'))
      || !Number.isInteger(port)
      || port < 1
      || port > 65535) {
      throw new Error('Temporary port environment settings are not valid.');
    }
    for (const key of Object.keys(environment)) {
      if (key.toLocaleLowerCase('en-US') === variable.toLocaleLowerCase('en-US')) {
        delete environment[key];
      }
    }
    environment[variable] = String(port);
  }
  return environment;
}

function parseTemporaryPort(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(text)) {
    return undefined;
  }
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function effectiveProjectPortOverrides(project) {
  return (project?.services || []).flatMap((service) => (
    service?.temporaryPort === true
      ? [{
          serviceName: service.name,
          savedPort: service.savedPort,
          port: service.port,
          variable: service.portVariable
        }]
      : []
  ));
}

function mergePortOverride(project, overrides, nextOverride) {
  const current = normalizePortOverrides(project, overrides);
  return normalizePortOverrides(project, [
    ...current.filter((override) => override.serviceName !== nextOverride?.serviceName),
    nextOverride
  ]);
}

function portVariableValidationMessage(value) {
  const variable = String(value || '').trim();
  if (variable.length > 128) {
    return 'Use no more than 128 characters.';
  }
  if (!PORT_VARIABLE_PATTERN.test(variable)) {
    return 'Use letters, numbers, and underscores, starting with a letter or underscore.';
  }
  if (BLOCKED_PORT_VARIABLES.has(variable.toLocaleLowerCase('en-US'))) {
    return 'Choose an app-specific variable instead of a system environment variable.';
  }
  return undefined;
}

function optionalPortVariableValidationMessage(value) {
  return String(value || '').trim()
    ? portVariableValidationMessage(value)
    : undefined;
}

function rewriteLoopbackServiceUrl(value, savedPort, temporaryPort) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase('en-US');
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    const urlPort = url.port
      ? Number(url.port)
      : url.protocol === 'http:'
        ? 80
        : url.protocol === 'https:'
          ? 443
          : undefined;
    if (!loopback || urlPort !== savedPort) {
      return value;
    }
    url.port = String(temporaryPort);
    return url.toString();
  } catch {
    return value;
  }
}

module.exports = {
  effectiveProjectPortOverrides,
  mergePortOverride,
  normalizePortOverrides,
  optionalPortVariableValidationMessage,
  parseTemporaryPort,
  portVariableValidationMessage,
  projectLaunchEnvironment,
  projectWithPortOverrides,
  rewriteLoopbackServiceUrl
};
