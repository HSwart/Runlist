const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allocateLocalHostname,
  buildNamedLocalUrl,
  defaultLocalHostname,
  findLocalHostnameCollisions,
  localHostnameValidationMessage,
  preferredServiceOpenUrl,
  resolveDistinctLocalHostnames,
  slugifyLocalHostname
} = require('../src/services/local-hostname');

test('slugifies project names into DNS labels', () => {
  assert.equal(slugifyLocalHostname('My App'), 'my-app');
  assert.equal(slugifyLocalHostname('API_v2'), 'api-v2');
  assert.equal(slugifyLocalHostname('---'), undefined);
  assert.equal(slugifyLocalHostname(''), undefined);
});

test('rejects invalid DNS labels plainly', () => {
  assert.match(localHostnameValidationMessage('Bad Host'), /letters|digits|hyphen/i);
  assert.match(localHostnameValidationMessage('-leading'), /start|end/i);
  assert.match(localHostnameValidationMessage('a'.repeat(64)), /63/i);
  assert.equal(localHostnameValidationMessage('my-app'), undefined);
  assert.equal(localHostnameValidationMessage(''), undefined);
});

test('defaults hostname from stored label or project name slug', () => {
  assert.equal(defaultLocalHostname({ name: 'Web App', localHostname: 'web' }), 'web');
  assert.equal(defaultLocalHostname({ name: 'Web App' }), 'web-app');
});

test('allocates collision-safe hostnames with -2 suffix', () => {
  assert.equal(allocateLocalHostname('web', []), 'web');
  assert.equal(allocateLocalHostname('web', ['web']), 'web-2');
  assert.equal(allocateLocalHostname('web', ['web', 'web-2']), 'web-3');
});

test('resolves distinct hostnames for enabled projects', () => {
  const assignments = resolveDistinctLocalHostnames([
    { id: 'a', name: 'Web' },
    { id: 'b', name: 'Web App' },
    { id: 'c', name: 'Other' }
  ], new Set(['a', 'b']));
  assert.equal(assignments.get('a'), 'web');
  assert.equal(assignments.get('b'), 'web-app');
  assert.equal(assignments.has('c'), false);
});

test('builds named localhost URLs only when toggle is on', () => {
  assert.equal(
    buildNamedLocalUrl({ hostname: 'web', port: 3000 }),
    'http://web.localhost:3000/'
  );
  assert.equal(
    preferredServiceOpenUrl({
      project: { name: 'Web', localHostname: 'web' },
      service: { name: 'web', port: 3000 },
      port: 3000
    }),
    'http://localhost:3000/'
  );
  assert.equal(
    preferredServiceOpenUrl({
      project: { name: 'Web', localHostname: 'web' },
      service: { name: 'web', port: 3000 },
      port: 3000,
      useNamedLocalhost: true
    }),
    'http://web.localhost:3000/'
  );
  assert.equal(
    preferredServiceOpenUrl({
      project: { name: 'Web', localHostname: 'web' },
      service: { name: 'web', port: 3000, url: 'https://app.local/dashboard' },
      port: 3000,
      useNamedLocalhost: true
    }),
    'https://app.local/dashboard'
  );
});

test('warns when another project already uses the hostname', () => {
  const collisions = findLocalHostnameCollisions([
    { id: 'a', name: 'Alpha', localHostname: 'web' },
    { id: 'b', name: 'Beta', localHostname: 'web' },
    { id: 'c', name: 'Web' }
  ], 'web', 'a');
  assert.deepEqual(collisions.map((project) => project.id), ['b', 'c']);
});
