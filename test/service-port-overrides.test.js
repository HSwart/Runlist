const assert = require('node:assert/strict');
const test = require('node:test');
const {
  effectiveProjectPortOverrides,
  mergePortOverride,
  normalizePortOverrides,
  parseTemporaryPort,
  portVariableValidationMessage,
  projectLaunchEnvironment,
  projectWithPortOverrides,
  rewriteLoopbackServiceUrl
} = require('../service-port-overrides');

const project = {
  id: 'multi',
  services: [
    { name: 'web', port: 3000, url: 'http://localhost:3000/dashboard?tab=all' },
    { name: 'api', port: 4000, portVariable: 'API_PORT' },
    { name: 'docs', port: 5000, url: 'https://docs.example.test:5000/guide' }
  ]
};

test('applies a temporary port to one service without changing the saved project', () => {
  const overrides = normalizePortOverrides(project, [{
    serviceName: 'api',
    savedPort: 4000,
    port: 4001,
    variable: 'API_PORT'
  }]);
  const effective = projectWithPortOverrides(project, overrides);

  assert.deepEqual(effective.services[0], project.services[0]);
  assert.deepEqual(effective.services[1], {
    name: 'api',
    port: 4001,
    savedPort: 4000,
    portVariable: 'API_PORT',
    temporaryPort: true
  });
  assert.equal(project.services[1].port, 4000);
});

test('rejects stale, duplicate, unsafe, and colliding temporary settings', () => {
  assert.throws(() => normalizePortOverrides(project, [{
    serviceName: 'api', savedPort: 3999, port: 4001, variable: 'API_PORT'
  }]), /saved service changed/);
  assert.throws(() => normalizePortOverrides(project, [{
    serviceName: 'api', savedPort: 4000, port: 3000, variable: 'API_PORT'
  }]), /different from every other/);
  assert.throws(() => normalizePortOverrides(project, [{
    serviceName: 'api', savedPort: 4000, port: 4001, variable: 'PATH'
  }]), /portable, non-system/);
});

test('accepts an explicit launch-only variable for an unconfigured service', () => {
  assert.deepEqual(normalizePortOverrides(project, [{
    serviceName: 'web', savedPort: 3000, port: 3001, variable: 'PORT'
  }]), [{
    serviceName: 'web', savedPort: 3000, port: 3001, variable: 'PORT'
  }]);
  assert.deepEqual(mergePortOverride(project, [{
    serviceName: 'api', savedPort: 4000, port: 4001, variable: 'API_PORT'
  }], {
    serviceName: 'api', savedPort: 4000, port: 4002, variable: 'OTHER_PORT'
  }), [{
    serviceName: 'api', savedPort: 4000, port: 4002, variable: 'OTHER_PORT'
  }]);
});

test('sets launch variables case-insensitively without mutating the parent environment', () => {
  const base = { Path: 'system-path', API_PORT: '4000', KEEP: 'yes' };
  const environment = projectLaunchEnvironment(base, [{
    serviceName: 'api', savedPort: 4000, port: 4001, variable: 'api_port'
  }]);

  assert.deepEqual(base, { Path: 'system-path', API_PORT: '4000', KEEP: 'yes' });
  assert.equal(environment.API_PORT, undefined);
  assert.equal(environment.api_port, '4001');
  assert.equal(environment.Path, 'system-path');
  assert.equal(environment.KEEP, 'yes');
});

test('recovers temporary environment settings from an effective project for custom Stop', () => {
  const effective = projectWithPortOverrides(project, [{
    serviceName: 'api', savedPort: 4000, port: 4001, variable: 'API_PORT'
  }]);

  assert.deepEqual(effectiveProjectPortOverrides(effective), [{
    serviceName: 'api', savedPort: 4000, port: 4001, variable: 'API_PORT'
  }]);
  assert.deepEqual(effectiveProjectPortOverrides(project), []);
});

test('rewrites matching explicit and default loopback URL ports', () => {
  assert.equal(
    rewriteLoopbackServiceUrl('http://localhost:3000/dashboard?tab=all', 3000, 3001),
    'http://localhost:3001/dashboard?tab=all'
  );
  assert.equal(
    rewriteLoopbackServiceUrl('http://[::1]:3000/dashboard', 3000, 3001),
    'http://[::1]:3001/dashboard'
  );
  assert.equal(
    rewriteLoopbackServiceUrl('https://docs.example.test:5000/guide', 5000, 5001),
    'https://docs.example.test:5000/guide'
  );
  assert.equal(
    rewriteLoopbackServiceUrl('http://localhost/dashboard', 80, 3001),
    'http://localhost:3001/dashboard'
  );
  assert.equal(
    rewriteLoopbackServiceUrl('https://localhost/dashboard', 443, 3443),
    'https://localhost:3443/dashboard'
  );
  assert.equal(rewriteLoopbackServiceUrl('http://localhost/dashboard', 3000, 3001), 'http://localhost/dashboard');
});

test('validates configured port variables without guessing them', () => {
  assert.equal(portVariableValidationMessage('API-PORT'), 'Use letters, numbers, and underscores, starting with a letter or underscore.');
  assert.equal(portVariableValidationMessage('SystemRoot'), 'Choose an app-specific variable instead of a system environment variable.');
  assert.equal(portVariableValidationMessage('LD_PRELOAD'), 'Choose an app-specific variable instead of a system environment variable.');
  assert.equal(portVariableValidationMessage(`P${'A'.repeat(128)}`), 'Use no more than 128 characters.');
  assert.equal(portVariableValidationMessage('API_PORT'), undefined);
});

test('accepts only plain decimal temporary port input', () => {
  assert.equal(parseTemporaryPort(' 4001 '), 4001);
  assert.equal(parseTemporaryPort('65535'), 65535);
  assert.equal(parseTemporaryPort('1e3'), undefined);
  assert.equal(parseTemporaryPort('4001.0'), undefined);
  assert.equal(parseTemporaryPort('0'), undefined);
  assert.equal(parseTemporaryPort('65536'), undefined);
});
