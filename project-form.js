const MAX_SERVICES = 32;

const FIELD_ORDER = ['project-name', 'folder', 'start-command', 'stop-command'];

function projectFormValues(input = {}) {
  const services = Array.isArray(input.services)
    ? input.services.map((service) => ({
      name: String(service?.name || ''),
      port: String(service?.port ?? '')
    }))
    : input.appPort === undefined || String(input.appPort).trim() === ''
      ? []
      : [{ name: 'app', port: String(input.appPort) }];

  return {
    id: String(input.id || ''),
    name: String(input.name || ''),
    folder: String(input.folder || ''),
    startCommand: String(input.startCommand || ''),
    stopCommand: String(input.stopCommand || ''),
    services
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
  if (!values.stopCommand.trim()) {
    errors['stop-command'] = 'Enter a stop command.';
  }
  if (values.services.length > MAX_SERVICES) {
    errors.services = `A project can have up to ${MAX_SERVICES} services.`;
  }

  const names = new Map();
  const ports = new Map();
  values.services.forEach((service, index) => {
    const name = service.name.trim();
    const nameKey = name.toLocaleLowerCase();
    const portText = service.port.trim();
    const port = Number(portText);
    if (!name || name.length > 64) {
      errors[`service-name-${index}`] = 'Enter a service name with 1 to 64 characters.';
    } else if (names.has(nameKey)) {
      errors[`service-name-${index}`] = `Use a unique name; ${name} is already listed.`;
    } else {
      names.set(nameKey, index);
    }

    if (!portText || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors[`service-port-${index}`] = 'Enter a whole-number port from 1 to 65535.';
    } else if (ports.has(port)) {
      const firstService = values.services[ports.get(port)].name.trim() || 'another service';
      errors[`service-port-${index}`] = `Port ${port} is already used by ${firstService}.`;
    } else {
      ports.set(port, index);
    }
  });

  const serviceFields = values.services.flatMap((_, index) => [
    `service-name-${index}`,
    `service-port-${index}`
  ]);
  const order = [...FIELD_ORDER, 'services', ...serviceFields];
  return {
    errors,
    firstField: order.find((field) => errors[field]),
    values
  };
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
  if (/service|port/i.test(message)) {
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
  projectFormValues,
  projectSaveError,
  validateProjectForm
};
