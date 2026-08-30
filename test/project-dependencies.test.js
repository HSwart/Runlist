const assert = require('node:assert/strict');
const test = require('node:test');
const {
  dependencyCycleMessage,
  dependencyLayers,
  normalizeDependsOn,
  orderProjectsByDependencies,
  unresolvedDependencies
} = require('../src/projects/project-dependencies');

test('orderProjectsByDependencies respects dependency order', () => {
  const projectsById = new Map([
    ['api', { id: 'api', name: 'API', dependsOn: [] }],
    ['web', { id: 'web', name: 'Web', dependsOn: ['api'] }]
  ]);
  assert.deepEqual(
    orderProjectsByDependencies(['web', 'api'], projectsById),
    ['api', 'web']
  );
});

test('orderProjectsByDependencies ignores dependencies outside the run group', () => {
  const projectsById = new Map([
    ['api', { id: 'api', name: 'API', dependsOn: [] }],
    ['web', { id: 'web', name: 'Web', dependsOn: ['api'] }]
  ]);
  assert.deepEqual(
    orderProjectsByDependencies(['web'], projectsById),
    ['web']
  );
});

test('dependencyLayers groups parallel-ready projects by dependency depth', () => {
  const projectsById = new Map([
    ['api', { id: 'api', name: 'API', dependsOn: [] }],
    ['admin', { id: 'admin', name: 'Admin', dependsOn: [] }],
    ['web', { id: 'web', name: 'Web', dependsOn: ['api'] }]
  ]);
  assert.deepEqual(
    dependencyLayers(['web', 'api', 'admin'], projectsById),
    [['api', 'admin'], ['web']]
  );
});

test('orderProjectsByDependencies rejects dependency cycles', () => {
  const projectsById = new Map([
    ['api', { id: 'api', name: 'API', dependsOn: ['web'] }],
    ['web', { id: 'web', name: 'Web', dependsOn: ['api'] }]
  ]);
  assert.throws(
    () => orderProjectsByDependencies(['api', 'web'], projectsById),
    /Dependency cycle detected/
  );
  assert.match(dependencyCycleMessage(['api', 'web'], projectsById), /API/);
});

test('normalizeDependsOn rejects self references and unknown projects', () => {
  const projectsById = new Map([['api', { id: 'api', name: 'API' }]]);
  assert.throws(
    () => normalizeDependsOn(['api'], 'api', projectsById),
    /cannot depend on itself/
  );
  assert.throws(
    () => normalizeDependsOn(['missing'], 'web', projectsById),
    /not saved in Runlist/
  );
});

test('unresolvedDependencies waits for ready dependencies', () => {
  const projectsById = new Map([
    ['api', { id: 'api', name: 'API', dependsOn: [] }],
    ['web', { id: 'web', name: 'Web', dependsOn: ['api'] }]
  ]);
  const waiting = unresolvedDependencies(
    projectsById.get('web'),
    projectsById,
    (id) => (id === 'api' ? 'stopped' : 'stopped')
  );
  assert.deepEqual(waiting, [{ projectId: 'api', name: 'API', status: 'stopped' }]);
  assert.equal(
    unresolvedDependencies(
      projectsById.get('web'),
      projectsById,
      (id) => (id === 'api' ? 'running' : 'stopped')
    ).length,
    0
  );
});
