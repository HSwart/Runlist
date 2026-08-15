const assert = require('node:assert/strict');
const test = require('node:test');
const {
  projectFormChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
} = require('../project-form');

test('validates project fields and selects the first invalid control', () => {
  const invalid = validateProjectForm({ appPort: '70000' });
  assert.equal(invalid.firstField, 'folder');
  assert.deepEqual(Object.keys(invalid.errors), [
    'folder',
    'start-command',
    'stop-command',
    'app-port'
  ]);

  const valid = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    appPort: '3000'
  });
  assert.deepEqual(valid.errors, {});
  assert.equal(valid.firstField, undefined);
});

test('normalizes stored services for form comparison', () => {
  const stored = {
    id: 'project-1',
    name: 'Project',
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: [{ name: 'web', port: 3000 }]
  };
  const form = projectFormValues(stored);
  assert.equal(form.appPort, '3000');
  assert.equal(projectFormChanged(form, stored), false);
  assert.equal(projectFormChanged({ ...form, name: 'Renamed' }, stored), true);
});

test('maps storage errors to the related form control', () => {
  assert.equal(projectSaveError(new Error('folder does not exist')).field, 'folder');
  assert.equal(projectSaveError(new Error('services[0].port must be valid')).field, 'app-port');
  assert.equal(projectSaveError(new Error('service names must be unique')).field, 'app-port');
  assert.equal(projectSaveError(new Error('The project no longer exists.')).field, 'form');
});
