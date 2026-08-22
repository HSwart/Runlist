const assert = require('node:assert/strict');
const test = require('node:test');
const {
  launchProfileOptions,
  resolveLaunchProfile,
  selectedLaunchProfileId
} = require('../src/projects/launch-profile');

const project = {
  id: 'project-1',
  name: 'Project',
  folder: 'C:\\project',
  startCommand: 'npm run dev',
  stopCommand: 'npm run stop',
  services: [{ name: 'web', port: 3000 }],
  launchProfiles: [{
    id: 'tests',
    name: 'Tests',
    startCommand: 'npm test',
    services: [{ name: 'test-api', port: 4311 }]
  }],
  selectedLaunchProfileId: 'tests'
};

test('resolves the selected launch profile without mutating stored defaults', () => {
  const resolved = resolveLaunchProfile(project);

  assert.equal(resolved.startCommand, 'npm test');
  assert.equal(Object.hasOwn(resolved, 'stopCommand'), false);
  assert.deepEqual(resolved.services, [{ name: 'test-api', port: 4311 }]);
  assert.equal(resolved.activeLaunchProfileId, 'tests');
  assert.equal(project.startCommand, 'npm run dev');
});

test('falls back to Default when a saved selection no longer exists', () => {
  const stale = { ...project, selectedLaunchProfileId: 'missing' };

  assert.equal(selectedLaunchProfileId(stale), 'default');
  assert.equal(resolveLaunchProfile(stale).startCommand, 'npm run dev');
  assert.deepEqual(launchProfileOptions(stale).map(({ id, name }) => ({ id, name })), [
    { id: 'default', name: 'Default' },
    { id: 'tests', name: 'Tests' }
  ]);
});
