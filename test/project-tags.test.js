const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeProjectTags,
  projectTagVocabulary
} = require('../src/projects/project-tags');

test('normalizes, deduplicates, and orders comma-separated project tags', () => {
  assert.deepEqual(
    normalizeProjectTags(' Frontend, customer   portal, FRONTEND, api '),
    ['Frontend', 'customer portal', 'api']
  );
});

test('rejects oversized, excessive, and unsafe tags', () => {
  assert.throws(() => normalizeProjectTags(['contains,comma']), /commas/);
  assert.throws(() => normalizeProjectTags(['line\nbreak']), /control/);
  assert.throws(() => normalizeProjectTags(['x'.repeat(33)]), /32/);
  assert.throws(() => normalizeProjectTags(Array.from({ length: 13 }, (_, index) => `tag-${index}`)), /12/);
});

test('builds a stable case-insensitive tag vocabulary', () => {
  assert.deepEqual(projectTagVocabulary([
    { tags: ['Frontend', 'api'] },
    { tags: ['frontend', 'Customer Portal'] }
  ]), ['api', 'Customer Portal', 'Frontend']);
});
