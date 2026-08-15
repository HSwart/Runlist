const assert = require('node:assert/strict');
const test = require('node:test');
const {
  projectFormChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
} = require('../project-form');

test('validates project fields and selects the first invalid control', () => {
  const invalid = validateProjectForm({ services: [{ name: '', port: '70000' }] });
  assert.equal(invalid.firstField, 'folder');
  assert.deepEqual(Object.keys(invalid.errors), [
    'folder',
    'start-command',
    'stop-command',
    'service-name-0',
    'service-port-0'
  ]);

  const valid = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
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
    services: form.services.map((service, index) => index === 1
      ? { ...service, port: '4001' }
      : service)
  }, stored), true);
  assert.equal(projectFormChanged({ ...form, services: [form.services[0]] }, stored), true);
});

test('explains duplicate names and ports beside the repeated service', () => {
  const validation = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: [
      { name: 'web', port: '3000' },
      { name: 'WEB', port: '3000' }
    ]
  });
  assert.match(validation.errors['service-name-1'], /already listed/);
  assert.match(validation.errors['service-port-1'], /already used by web/);
  assert.equal(validation.firstField, 'service-name-1');
});

test('retains the 32-service limit', () => {
  const validation = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: Array.from({ length: 33 }, (_, index) => ({
      name: `service-${index}`,
      port: String(3000 + index)
    }))
  });
  assert.equal(validation.errors.services, 'A project can have up to 32 services.');
  assert.equal(validation.firstField, 'services');
});

test('maps storage errors to the related form control', () => {
  assert.equal(projectSaveError(new Error('folder does not exist')).field, 'folder');
  assert.equal(projectSaveError(new Error('services[2].port must be valid')).field, 'service-port-2');
  assert.equal(projectSaveError(new Error('service names must be unique')).field, 'services');
  assert.equal(projectSaveError(new Error('The project no longer exists.')).field, 'form');
});
