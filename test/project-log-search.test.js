const assert = require('node:assert/strict');
const test = require('node:test');
const { searchProjectLogs } = require('../src/projects/project-log-search');

test('searchProjectLogs finds matching lines across projects', () => {
  const outputs = new Map([
    ['api', 'listening on 3000\nready for traffic\n'],
    ['web', 'compiled successfully\n']
  ]);
  const projects = [
    { id: 'api', name: 'API' },
    { id: 'web', name: 'Web' }
  ];
  const results = searchProjectLogs(outputs, projects, 'ready');
  assert.equal(results.length, 1);
  assert.equal(results[0].projectId, 'api');
  assert.equal(results[0].matches[0].lineNumber, 2);
  assert.match(results[0].matches[0].excerpt, /ready for traffic/);
});

test('searchProjectLogs returns nothing for blank queries', () => {
  const outputs = new Map([['api', 'error: boom']]);
  const projects = [{ id: 'api', name: 'API' }];
  assert.deepEqual(searchProjectLogs(outputs, projects, '   '), []);
});
