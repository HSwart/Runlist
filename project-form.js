const FIELD_ORDER = ['project-name', 'folder', 'start-command', 'stop-command', 'app-port'];

function projectFormValues(input = {}) {
  return {
    id: String(input.id || ''),
    name: String(input.name || ''),
    folder: String(input.folder || ''),
    startCommand: String(input.startCommand || ''),
    stopCommand: String(input.stopCommand || ''),
    appPort: String(input.appPort ?? input.services?.[0]?.port ?? '')
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
  if (values.appPort.trim()) {
    const port = Number(values.appPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors['app-port'] = 'Enter a whole-number port from 1 to 65535.';
    }
  }
  return {
    errors,
    firstField: FIELD_ORDER.find((field) => errors[field]),
    values
  };
}

function projectFormChanged(input, baseline) {
  const current = projectFormValues(input);
  const original = projectFormValues(baseline);
  return Object.keys(current).some((key) => current[key] !== original[key]);
}

function projectSaveError(error) {
  const message = String(error?.message || 'Could not save this project.');
  if (/service|port/i.test(message)) {
    return { field: 'app-port', message };
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
  projectFormChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
};
