const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSearchQuery,
  projectMatchesQuery,
  projectSearchText
} = require('../project-search');

const project = {
  name: 'goSearch',
  folder: 'C:\\Users\\Example User\\Git Projects\\goSearch'
};

test('normalizes project searches for case-insensitive matching', () => {
  assert.equal(normalizeSearchQuery('  GOsearch  '), 'gosearch');
});

test('finds projects by name or folder', () => {
  assert.equal(projectMatchesQuery(project, 'GOSEARCH'), true);
  assert.equal(projectMatchesQuery(project, 'search'), true);
  assert.equal(projectMatchesQuery(project, 'git projects'), true);
  assert.equal(projectMatchesQuery(project, 'missing'), false);
});

test('builds a reusable search index from the project name and folder', () => {
  assert.equal(
    projectSearchText(project),
    'gosearch\nc:\\users\\example user\\git projects\\gosearch'
  );
});

test('shows every project when the search is empty', () => {
  assert.equal(projectMatchesQuery(project, '  '), true);
});
