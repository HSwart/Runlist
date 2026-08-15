const FIELD_ORDER = ['project-name', 'folder', 'start-command', 'stop-command'];
const MAX_SERVICES = 32;

function projectFormValues(input = {}) {
  const sourceServices = Array.isArray(input.services)
    ? input.services
    : input.appPort === undefined || input.appPort === ''
      ? []
      : [{ name: 'app', port: input.appPort }];
  return {
    id: String(input.id || ''),
    name: String(input.name || ''),
    folder: String(input.folder || ''),
    startCommand: String(input.startCommand || ''),
    stopCommand: String(input.stopCommand || ''),
    services: sourceServices.map((service) => ({
      name: String(service?.name ?? ''),
      port: String(service?.port ?? '')
    }))
  };
}

function validateProjectForm(input) {
  const values = projectFormValues(input);
  const errors = {};
  if (values.name.trim().length > 100) {
    errors['project-name'] = 'Project name cannot contain more than 100 characters.';
  }
  if (!values.folder.trim()) {
    errors.folder = 'Choose a project folder.';
  }
  if (!values.startCommand.trim()) {
    errors['start-command'] = 'Enter a start command.';
  }
  if (values.services.length > MAX_SERVICES) {
    errors.services = `Configure no more than ${MAX_SERVICES} services.`;
  }

  const names = new Map();
  const ports = new Map();
  values.services.forEach((service, index) => {
    const name = service.name.trim();
    const portText = service.port.trim();
    if (!name && !portText) {
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
  });

  const serviceFields = values.services.flatMap((service, index) => [
    `service-name-${index}`,
    `service-port-${index}`
  ]);
  return {
    errors,
    firstField: [...FIELD_ORDER, 'services', ...serviceFields].find((field) => errors[field]),
    values
  };
}

function projectFormServices(values) {
  return projectFormValues(values).services
    .filter((service) => service.name.trim() || service.port.trim())
    .map((service) => ({
      name: service.name.trim(),
      port: Number(service.port.trim())
    }));
}

function projectFormChanged(input, baseline) {
  const current = projectFormValues(input);
  const original = projectFormValues(baseline);
  return JSON.stringify(current) !== JSON.stringify(original);
}

function projectSaveError(error) {
  const message = String(error?.message || 'Could not save this project.');
  const serviceField = message.match(/services\[(\d+)\]\.(name|port)/);
  if (serviceField) {
    return { field: `service-${serviceField[2]}-${serviceField[1]}`, message };
  }
  if (/service/i.test(message)) {
    return { field: 'services', message };
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
  projectFormServices,
  projectFormValues,
  projectSaveError,
  validateProjectForm
};
