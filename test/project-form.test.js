const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_SERVICES,
  projectFormChanged,
  projectFormServices,
  projectFormSetup,
  projectServicesChanged,
  projectFormValues,
  projectSaveError,
  validateProjectForm
} = require('../src/projects/project-form');

test('round-trips alternate launch profiles through the project form model', () => {
  const setup = projectFormSetup({
    startCommand: 'npm run dev',
    services: [{ name: 'web', port: '3000' }],
    launchProfiles: [{
      id: 'tests',
      name: ' Tests ',
      startCommand: ' npm test ',
      services: [{ name: 'api', port: '4311' }]
    }],
    selectedLaunchProfileId: 'tests',
    editingLaunchProfileId: 'tests'
  });

  assert.equal(setup.startCommand, 'npm run dev');
  assert.equal(setup.launchProfiles[0].name, 'Tests');
  assert.equal(setup.launchProfiles[0].startCommand, 'npm test');
  assert.deepEqual(setup.launchProfiles[0].services, [{ name: 'api', port: 4311 }]);
  assert.equal(setup.selectedLaunchProfileId, 'tests');
});

test('allows eleven alternates for twelve total profiles and reports the same limit', () => {
  const profile = (index) => ({
    id: `profile-${index}`,
    name: `Profile ${index}`,
    startCommand: `npm run profile-${index}`,
    services: []
  });
  const input = {
    folder: '/tmp/project',
    startCommand: 'npm start',
    services: [],
    launchProfiles: Array.from({ length: 11 }, (_, index) => profile(index))
  };

  assert.equal(validateProjectForm(input).errors.form, undefined);
  assert.equal(
    validateProjectForm({ ...input, launchProfiles: [...input.launchProfiles, profile(11)] })
      .errors.form,
    'Configure no more than 11 alternate launch profiles (12 including Default).'
  );
});

test('reveals and validates an invalid profile even when another profile is being edited', () => {
  const validation = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    services: [{ name: 'web', port: '3000' }],
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: '',
      services: [{
        name: 'api',
        port: '4311',
        healthCheck: { mode: 'http', timeoutMs: '5000' }
      }]
    }],
    selectedLaunchProfileId: 'default',
    editingLaunchProfileId: 'default'
  });

  assert.equal(validation.errorProfileId, 'tests');
  assert.equal(validation.values.editingLaunchProfileId, 'tests');
  assert.equal(validation.values.selectedLaunchProfileId, 'default');
  assert.equal(validation.errors['start-command'], 'Enter a start command.');
  assert.match(validation.errors['service-health-timeout-0'], /100 to 3000/);
  assert.equal(validation.firstField, 'start-command');
});

test('validates and stores explicit health checks without changing defaults', () => {
  const input = {
    folder: 'C:\\project',
    startCommand: 'npm start',
    services: [{
      name: 'web',
      port: '4310',
      url: 'http://localhost:4310',
      healthCheck: {
        mode: 'http',
        target: '/health',
        method: 'GET',
        expectedStatus: '204',
        timeoutMs: '1200',
        retries: '2'
      }
    }]
  };

  assert.deepEqual(validateProjectForm(input).errors, {});
  assert.deepEqual(projectFormServices(input)[0].healthCheck, {
    mode: 'http',
    target: '/health',
    method: 'GET',
    expectedStatus: 204,
    timeoutMs: 1200,
    retries: 2
  });
  const invalid = validateProjectForm({
    ...input,
    services: [{
      ...input.services[0],
      healthCheck: { ...input.services[0].healthCheck, timeoutMs: '5000' }
    }]
  });
  assert.equal(invalid.firstField, 'service-health-timeout-0');

  for (const target of ['//example.test/health', '/\\example.test/health']) {
    const escaped = validateProjectForm({
      ...input,
      services: [{
        ...input.services[0],
        healthCheck: { ...input.services[0].healthCheck, target }
      }]
    });
    assert.match(escaped.errors['service-health-target-0'], /safe HTTP\/HTTPS URL/);
  }
});

test('validates and normalizes optional project tags', () => {
  const input = {
    folder: '/tmp/project',
    startCommand: 'npm start',
    tags: ' Frontend, customer   portal, FRONTEND '
  };
  const validation = validateProjectForm(input);
  assert.equal(validation.errors.tags, undefined);
  assert.deepEqual(projectFormSetup(input).tags, ['Frontend', 'customer portal']);

  const invalid = validateProjectForm({
    ...input,
    tags: 'x'.repeat(33)
  });
  assert.match(invalid.errors.tags, /32/);
  assert.equal(invalid.firstField, 'tags');
});

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
      { name: 'api', port: 4000, url: 'https://api.local/docs' }
    ]
  };
  const form = projectFormValues(stored);
  assert.deepEqual(form.services, [
    {
      name: 'web',
      port: '3000',
      portVariable: '',
      url: '',
      healthCheck: {
        mode: 'default',
        target: '',
        method: 'HEAD',
        expectedStatus: '',
        timeoutMs: '700',
        retries: '0',
        bodyContains: ''
      }
    },
    {
      name: 'api',
      port: '4000',
      portVariable: '',
      url: 'https://api.local/docs',
      healthCheck: {
        mode: 'default',
        target: '',
        method: 'HEAD',
        expectedStatus: '',
        timeoutMs: '700',
        retries: '0',
        bodyContains: ''
      }
    }
  ]);
  assert.equal(projectFormChanged(form, stored), false);
  assert.equal(projectServicesChanged(form, stored), false);
  assert.equal(projectServicesChanged({
    ...form,
    services: [{ name: 'web', port: '3001' }]
  }, stored), true);
  assert.equal(projectFormChanged({ ...form, name: 'Renamed' }, stored), true);
  assert.equal(projectFormChanged({
    ...form,
    services: [{ name: 'web', port: '3001' }, form.services[1]]
  }, stored), true);
  assert.deepEqual(projectFormServices(form), stored.services);
});

test('validates and persists optional per-service port variables', () => {
  const input = {
    folder: '/tmp/project',
    startCommand: 'npm start',
    services: [
      { name: 'web', port: '3000', portVariable: 'PORT' },
      { name: 'api', port: '4000', portVariable: 'port' },
      { name: 'docs', port: '5000', portVariable: 'PATH' }
    ]
  };
  const validation = validateProjectForm(input);
  assert.equal(validation.errors['service-port-variable-0'], 'Use a unique variable for each service.');
  assert.equal(validation.errors['service-port-variable-1'], 'Use a unique variable for each service.');
  assert.match(validation.errors['service-port-variable-2'], /system environment variable/);

  assert.deepEqual(projectFormServices({
    ...input,
    services: [{ name: 'web', port: '3000', portVariable: 'PORT' }]
  }), [{ name: 'web', port: 3000, portVariable: 'PORT' }]);
});

test('explains duplicate and invalid values beside the relevant services', () => {
  const validation = validateProjectForm({
    folder: '/tmp/project',
    startCommand: 'npm start',
    stopCommand: 'npm stop',
    services: [
      { name: 'web', port: '3000' },
      { name: 'api', port: '3000' },
      { name: '', port: '70000' },
      { name: 'docs', port: '5000', url: 'javascript:alert(1)' }
    ]
  });

  assert.equal(validation.errors['service-port-0'], 'Use a unique port.');
  assert.equal(validation.errors['service-port-1'], 'Use a unique port.');
  assert.equal(validation.errors['service-name-2'], 'Enter a service name.');
  assert.match(validation.errors['service-port-2'], /1 to 65535/);
  assert.match(validation.errors['service-url-3'], /HTTP or HTTPS/);
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
  assert.equal(projectSaveError(new Error('services[1].url must be valid')).field, 'service-url-1');
  assert.equal(projectSaveError(new Error('service names must be unique')).field, 'services');
  assert.equal(projectSaveError(new Error('The project no longer exists.')).field, 'form');
});

test('validates and round-trips env file and env map on profiles', () => {
  const valid = validateProjectForm({
    folder: '/tmp/app',
    startCommand: 'npm run dev',
    envFile: '.env',
    envText: 'FLAG=1\nNOTE=hello',
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm test',
      envFile: 'config/.env.tests',
      envText: 'FLAG=tests',
      services: []
    }],
    editingLaunchProfileId: 'default'
  });
  assert.deepEqual(valid.errors, {});
  const setup = projectFormSetup(valid.values);
  assert.equal(setup.envFile, '.env');
  assert.deepEqual(setup.env, { FLAG: '1', NOTE: 'hello' });
  assert.equal(setup.launchProfiles[0].envFile, 'config/.env.tests');
  assert.deepEqual(setup.launchProfiles[0].env, { FLAG: 'tests' });

  const invalid = validateProjectForm({
    folder: '/tmp/app',
    startCommand: 'npm run dev',
    envFile: '../.env',
    envText: 'not-valid',
    services: []
  });
  assert.match(invalid.errors['env-file'] || '', /inside the project folder/i);
  assert.match(invalid.errors['env-map'] || '', /KEY=value/i);
});
