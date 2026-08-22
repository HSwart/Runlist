const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSearchQuery,
  projectMatchesQuery,
  projectSearchText
} = require('../src/projects/project-search');

const project = {
  name: 'goSearch',
  folder: 'C:\\Users\\Example User\\Git Projects\\goSearch',
  tags: ['Frontend', 'Customer Portal']
};

test('normalizes project searches for case-insensitive matching', () => {
  assert.equal(normalizeSearchQuery('  GOsearch  '), 'gosearch');
});

test('finds projects by name, folder, or tag', () => {
  assert.equal(projectMatchesQuery(project, 'GOSEARCH'), true);
  assert.equal(projectMatchesQuery(project, 'search'), true);
  assert.equal(projectMatchesQuery(project, 'git projects'), true);
  assert.equal(projectMatchesQuery(project, 'customer portal'), true);
  assert.equal(projectMatchesQuery(project, 'missing'), false);
});

test('builds a reusable search index from the project name, folder, and tags', () => {
  assert.equal(
    projectSearchText(project),
    'gosearch\nc:\\users\\example user\\git projects\\gosearch\nfrontend\ncustomer portal'
  );
});

test('shows every project when the search is empty', () => {
  assert.equal(projectMatchesQuery(project, '  '), true);
});
