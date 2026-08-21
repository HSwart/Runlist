const MAX_PROJECT_TAGS = 12;
const MAX_PROJECT_TAG_LENGTH = 32;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function normalizeProjectTags(value) {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value === undefined || value === null
        ? []
        : invalidTags();
  const tags = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || CONTROL_CHARACTERS.test(candidate)
      || (Array.isArray(value) && candidate.includes(','))) {
      throw new Error('Tags cannot contain commas or control characters.');
    }
    const tag = candidate.trim().replace(/\s+/g, ' ');
    if (!tag) {
      continue;
    }
    if (tag.length > MAX_PROJECT_TAG_LENGTH) {
      throw new Error(`Each tag must contain no more than ${MAX_PROJECT_TAG_LENGTH} characters.`);
    }
    const identity = tag.toLocaleLowerCase();
    if (!seen.has(identity)) {
      seen.add(identity);
      tags.push(tag);
    }
  }
  if (tags.length > MAX_PROJECT_TAGS) {
    throw new Error(`Configure no more than ${MAX_PROJECT_TAGS} tags.`);
  }
  return tags;
}

function invalidTags() {
  throw new Error('Tags must be a comma-separated list.');
}

function projectTagVocabulary(projects) {
  const firstByIdentity = new Map();
  for (const project of projects || []) {
    for (const tag of project.tags || []) {
      const identity = tag.toLocaleLowerCase();
      if (!firstByIdentity.has(identity)) {
        firstByIdentity.set(identity, tag);
      }
    }
  }
  return [...firstByIdentity.values()].sort((left, right) => (
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  ));
}

module.exports = {
  MAX_PROJECT_TAG_LENGTH,
  MAX_PROJECT_TAGS,
  normalizeProjectTags,
  projectTagVocabulary
};
