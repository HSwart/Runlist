const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_SERVICES,
  projectFormChanged,
  projectFormServices,
  projectFormValues,
  projectSaveError,
  validateProjectForm
} = require('../project-form');

test('validates project fields and selects the first invalid control', () => {
  const invalid = validateProjectForm({
    services: [{ name: 'web', port: '70000' }]
  });
  assert.equal(invalid.firstField, 'folder');
  assert.deepEqual(Object.keys(invalid.errors), [
    'folder',
    'start-command',
    'service-port-0'
  ]);

  const valid = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    services: [
      { name: 'web', port: '3000' },
      { name: 'api', port: '4000' }
    ]
  });
  assert.deepEqual(valid.errors, {});
  assert.equal(valid.firstField, undefined);
});

test('normalizes and compares every stored service', () => {
  const stored = {
    id: 'project-1',
    name: 'Project',
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: [
      { name: 'web', port: 3000 },
      { name: 'api', port: 4000 }
    ]
  };
  const form = projectFormValues(stored);
  assert.deepEqual(form.services, [
    { name: 'web', port: '3000' },
    { name: 'api', port: '4000' }
  ]);
  assert.equal(projectFormChanged(form, stored), false);
  assert.equal(projectFormChanged({ ...form, name: 'Renamed' }, stored), true);
  assert.equal(projectFormChanged({
    ...form,
    services: [{ name: 'web', port: '3001' }, form.services[1]]
  }, stored), true);
  assert.deepEqual(projectFormServices(form), stored.services);
});

test('explains duplicate and invalid values beside the relevant services', () => {
  const validation = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: [
      { name: 'web', port: '3000' },
      { name: 'api', port: '3000' },
      { name: '', port: '70000' }
    ]
  });

  assert.equal(validation.errors['service-port-0'], 'Use a unique port.');
  assert.equal(validation.errors['service-port-1'], 'Use a unique port.');
  assert.equal(validation.errors['service-name-2'], 'Enter a service name.');
  assert.match(validation.errors['service-port-2'], /1 to 65535/);
  assert.equal(validation.firstField, 'service-port-0');
});

test('allows no manual services and retains the service-count limit', () => {
  const base = {
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop'
  };
  assert.deepEqual(validateProjectForm({ ...base, services: [] }).errors, {});

  const tooMany = validateProjectForm({
    ...base,
    services: Array.from({ length: MAX_SERVICES + 1 }, (_, index) => ({
      name: `service-${index}`,
      port: String(3000 + index)
    }))
  });
  assert.equal(tooMany.firstField, 'services');
  assert.match(tooMany.errors.services, /no more than 32/);
});

test('maps storage errors to the related form control', () => {
  assert.equal(projectSaveError(new Error('folder does not exist')).field, 'folder');
  assert.equal(projectSaveError(new Error('services[2].port must be valid')).field, 'service-port-2');
  assert.equal(projectSaveError(new Error('service names must be unique')).field, 'services');
  assert.equal(projectSaveError(new Error('The project no longer exists.')).field, 'form');
});
