const FIELD_ORDER = ['project-name', 'folder', 'start-command', 'stop-command'];
const MAX_SERVICES = 32;
const { safeServiceUrl } = require('../services/external-url');
const { optionalPortVariableValidationMessage } = require('../ports/service-port-overrides');
const { normalizeProjectTags } = require('./project-tags');
const {
  DEFAULT_LAUNCH_PROFILE_ID,
  DEFAULT_LAUNCH_PROFILE_NAME,
  MAX_LAUNCH_PROFILES
} = require('./launch-profile');

function serviceFormValues(services) {
  return (Array.isArray(services) ? services : []).map((service) => ({
    name: String(service?.name ?? ''),
    port: String(service?.port ?? ''),
    portVariable: String(service?.portVariable ?? ''),
    url: String(service?.url ?? ''),
    healthCheck: {
      mode: String(service?.healthCheck?.mode || 'default'),
      target: String(service?.healthCheck?.target || ''),
      method: String(service?.healthCheck?.method || 'HEAD'),
      expectedStatus: String(service?.healthCheck?.expectedStatus ?? ''),
      timeoutMs: String(service?.healthCheck?.timeoutMs ?? 700),
      retries: String(service?.healthCheck?.retries ?? 0)
    }
  }));
}

function projectFormValues(input = {}) {
  const sourceServices = Array.isArray(input.services)
    ? input.services
    : input.appPort === undefined || input.appPort === ''
      ? []
      : [{ name: 'app', port: input.appPort }];
  return {
    id: String(input.id || ''),
    name: String(input.name || ''),
    tags: Array.isArray(input.tags) ? input.tags.join(', ') : String(input.tags || ''),
    folder: String(input.folder || ''),
    startCommand: String(input.startCommand || ''),
    stopCommand: String(input.stopCommand || ''),
    services: serviceFormValues(sourceServices),
    launchProfiles: (Array.isArray(input.launchProfiles) ? input.launchProfiles : []).map((profile) => ({
      id: String(profile?.id || ''),
      name: String(profile?.name || ''),
      startCommand: String(profile?.startCommand || ''),
      stopCommand: String(profile?.stopCommand || ''),
      services: serviceFormValues(profile?.services)
    })),
    selectedLaunchProfileId: String(input.selectedLaunchProfileId || DEFAULT_LAUNCH_PROFILE_ID),
    editingLaunchProfileId: String(
      input.editingLaunchProfileId
      || input.selectedLaunchProfileId
      || DEFAULT_LAUNCH_PROFILE_ID
    )
  };
}

function projectFormActiveProfile(values) {
  if (values.editingLaunchProfileId === DEFAULT_LAUNCH_PROFILE_ID) {
    return {
      id: DEFAULT_LAUNCH_PROFILE_ID,
      name: DEFAULT_LAUNCH_PROFILE_NAME,
      startCommand: values.startCommand,
      stopCommand: values.stopCommand,
      services: values.services
    };
  }
  return values.launchProfiles.find((profile) => profile.id === values.editingLaunchProfileId)
    || {
      id: DEFAULT_LAUNCH_PROFILE_ID,
      name: DEFAULT_LAUNCH_PROFILE_NAME,
      startCommand: values.startCommand,
      stopCommand: values.stopCommand,
      services: values.services
    };
}

function validateProjectForm(input) {
  const values = projectFormValues(input);
  const activeProfile = projectFormActiveProfile(values);
  const errors = {};
  if (values.name.trim().length > 100) {
    errors['project-name'] = 'Project name cannot contain more than 100 characters.';
  }
  try {
    normalizeProjectTags(values.tags);
  } catch (error) {
    errors.tags = error.message;
  }
  if (!values.folder.trim()) {
    errors.folder = 'Choose a project folder.';
  }
  if (!activeProfile.startCommand.trim()) {
    errors['start-command'] = 'Enter a start command.';
  }
  if (activeProfile.services.length > MAX_SERVICES) {
    errors.services = `Configure no more than ${MAX_SERVICES} services.`;
  }
  if (values.launchProfiles.length >= MAX_LAUNCH_PROFILES) {
    errors['launch-profile-name'] = `Configure no more than ${MAX_LAUNCH_PROFILES} launch profiles.`;
  }
  const profileNames = new Map([[DEFAULT_LAUNCH_PROFILE_NAME.toLocaleLowerCase(), DEFAULT_LAUNCH_PROFILE_ID]]);
  values.launchProfiles.forEach((profile) => {
    const name = profile.name.trim();
    const normalized = name.toLocaleLowerCase();
    if (!name || name.length > 100) {
      if (profile.id === activeProfile.id) {
        errors['launch-profile-name'] = 'Profile name must contain 1 to 100 characters.';
      } else {
        errors.form ||= 'Every launch profile needs a name containing 1 to 100 characters.';
      }
    } else if (profileNames.has(normalized)) {
      if (profile.id === activeProfile.id) {
        errors['launch-profile-name'] = 'Use a unique launch profile name.';
      } else {
        errors.form ||= 'Launch profile names must be unique.';
      }
    } else {
      profileNames.set(normalized, profile.id);
    }
  });

  const names = new Map();
  const ports = new Map();
  const portVariables = new Map();
  activeProfile.services.forEach((service, index) => {
    const name = service.name.trim();
    const portText = service.port.trim();
    const url = service.url.trim();
    const portVariable = service.portVariable.trim();
    const health = service.healthCheck;
    if (!name && !portText && !portVariable && !url && health.mode === 'default') {
      return;
    }
    if (!name) {
      errors[`service-name-${index}`] = 'Enter a service name.';
    } else if (name.length > 64) {
      errors[`service-name-${index}`] = 'Service name cannot contain more than 64 characters.';
    } else {
      const normalizedName = name.toLowerCase();
      if (names.has(normalizedName)) {
        const firstIndex = names.get(normalizedName);
        errors[`service-name-${firstIndex}`] ||= 'Use a unique service name.';
        errors[`service-name-${index}`] = 'Use a unique service name.';
      } else {
        names.set(normalizedName, index);
      }
    }

    const port = Number(portText);
    if (!portText) {
      errors[`service-port-${index}`] = 'Enter a port.';
    } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors[`service-port-${index}`] = 'Enter a whole-number port from 1 to 65535.';
    } else if (ports.has(port)) {
      const firstIndex = ports.get(port);
      errors[`service-port-${firstIndex}`] ||= 'Use a unique port.';
      errors[`service-port-${index}`] = 'Use a unique port.';
    } else {
      ports.set(port, index);
    }
    if (url && !safeServiceUrl(url)) {
      errors[`service-url-${index}`] = 'Enter a valid HTTP or HTTPS URL without sign-in details.';
    }
    const portVariableError = optionalPortVariableValidationMessage(portVariable);
    if (portVariableError) {
      errors[`service-port-variable-${index}`] = portVariableError;
    } else if (portVariable) {
      const normalizedVariable = portVariable.toLocaleLowerCase('en-US');
      if (portVariables.has(normalizedVariable)) {
        const firstIndex = portVariables.get(normalizedVariable);
        errors[`service-port-variable-${firstIndex}`] ||= 'Use a unique variable for each service.';
        errors[`service-port-variable-${index}`] = 'Use a unique variable for each service.';
      } else {
        portVariables.set(normalizedVariable, index);
      }
    }
    if (!['default', 'port', 'http'].includes(health.mode)) {
      errors[`service-health-mode-${index}`] = 'Choose Default, Port only, or HTTP request.';
    }
    if (health.mode === 'http') {
      const target = health.target.trim();
      if (target && !target.startsWith('/') && !safeServiceUrl(target)) {
        errors[`service-health-target-${index}`] = 'Enter a safe HTTP/HTTPS URL or a path beginning with /.';
      }
      if (!['HEAD', 'GET'].includes(health.method)) {
        errors[`service-health-method-${index}`] = 'Choose HEAD or GET.';
      }
      const expectedStatus = health.expectedStatus.trim();
      if (expectedStatus
        && (!Number.isInteger(Number(expectedStatus))
          || Number(expectedStatus) < 100
          || Number(expectedStatus) > 599)) {
        errors[`service-health-status-${index}`] = 'Enter a status from 100 to 599, or leave it empty.';
      }
      const timeoutMs = Number(health.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) {
        errors[`service-health-timeout-${index}`] = 'Enter a timeout from 100 to 3000 ms.';
      }
      const retries = Number(health.retries);
      if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
        errors[`service-health-retries-${index}`] = 'Enter 0, 1, or 2 retries.';
      }
    }
  });

  const serviceFields = activeProfile.services.flatMap((service, index) => [
    `service-name-${index}`,
    `service-port-${index}`,
    `service-port-variable-${index}`,
    `service-url-${index}`,
    `service-health-mode-${index}`,
    `service-health-target-${index}`,
    `service-health-method-${index}`,
    `service-health-status-${index}`,
    `service-health-timeout-${index}`,
    `service-health-retries-${index}`
  ]);
  return {
    errors,
    firstField: ['project-name', 'tags', 'folder', 'launch-profile-name', 'start-command', 'stop-command', 'services', ...serviceFields, 'form']
      .find((field) => errors[field]),
    values
  };
}

function projectFormServices(values) {
  return projectFormValues(values).services
    .filter((service) => service.name.trim() || service.port.trim()
      || service.portVariable.trim() || service.url.trim()
      || service.healthCheck.mode !== 'default')
    .map((service) => ({
      name: service.name.trim(),
      port: Number(service.port.trim()),
      ...(service.portVariable.trim() ? { portVariable: service.portVariable.trim() } : {}),
      ...(service.url.trim() ? { url: service.url.trim() } : {}),
      ...(service.healthCheck.mode === 'port'
        ? { healthCheck: { mode: 'port' } }
        : service.healthCheck.mode === 'http'
          ? {
              healthCheck: {
                mode: 'http',
                ...(service.healthCheck.target.trim()
                  ? { target: service.healthCheck.target.trim() }
                  : {}),
                method: service.healthCheck.method,
                ...(service.healthCheck.expectedStatus.trim()
                  ? { expectedStatus: Number(service.healthCheck.expectedStatus) }
                  : {}),
                timeoutMs: Number(service.healthCheck.timeoutMs),
                retries: Number(service.healthCheck.retries)
              }
            }
          : {})
    }));
}

function normalizedProfileServices(services) {
  return projectFormServices({ services });
}

function projectFormSetup(input) {
  const values = projectFormValues(input);
  return {
    tags: normalizeProjectTags(values.tags),
    startCommand: values.startCommand.trim(),
    stopCommand: values.stopCommand.trim(),
    services: normalizedProfileServices(values.services),
    launchProfiles: values.launchProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name.trim(),
      startCommand: profile.startCommand.trim(),
      ...(profile.stopCommand.trim() ? { stopCommand: profile.stopCommand.trim() } : {}),
      services: normalizedProfileServices(profile.services)
    })),
    selectedLaunchProfileId: values.selectedLaunchProfileId
  };
}

function projectFormChanged(input, baseline) {
  const current = projectFormValues(input);
  const original = projectFormValues(baseline);
  delete current.editingLaunchProfileId;
  delete original.editingLaunchProfileId;
  return JSON.stringify(current) !== JSON.stringify(original);
}

function projectServicesChanged(input, baseline) {
  const configurations = (value) => {
    const setup = projectFormSetup(value);
    return [setup.services, ...setup.launchProfiles.map((profile) => profile.services)];
  };
  return JSON.stringify(configurations(input)) !== JSON.stringify(configurations(baseline));
}

function projectSaveError(error) {
  const message = String(error?.message || 'Could not save this project.');
  const healthField = message.match(/services\[(\d+)\]\.healthCheck\.(mode|target|method|expectedStatus|timeoutMs|retries)\b/);
  if (healthField) {
    const names = {
      mode: 'mode',
      target: 'target',
      method: 'method',
      expectedStatus: 'status',
      timeoutMs: 'timeout',
      retries: 'retries'
    };
    return { field: `service-health-${names[healthField[2]]}-${healthField[1]}`, message };
  }
  const serviceField = message.match(/services\[(\d+)\]\.(name|portVariable|port|url)\b/);
  if (serviceField) {
    const fieldName = serviceField[2] === 'portVariable' ? 'port-variable' : serviceField[2];
    return { field: `service-${fieldName}-${serviceField[1]}`, message };
  }
  if (/service/i.test(message)) {
    return { field: 'services', message };
  }
  if (/launchProfiles|selectedLaunchProfileId|launch profile/i.test(message)) {
    return { field: 'launch-profile-name', message };
  }
  if (/tag/i.test(message)) {
    return { field: 'tags', message };
  }
  if (/name/i.test(message)) {
    return { field: 'project-name', message };
  }
  if (/folder/i.test(message)) {
    return { field: 'folder', message };
  }
  if (/startCommand/i.test(message)) {
    return { field: 'start-command', message };
  }
  if (/stopCommand/i.test(message)) {
    return { field: 'stop-command', message };
  }
  return { field: 'form', message };
}

module.exports = {
  MAX_SERVICES,
  projectFormChanged,
  projectFormActiveProfile,
  projectFormSetup,
  projectFormServices,
  projectServicesChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
};
