const { sanitizeProjectOutput } = require('./project-output');
const { normalizeSearchQuery } = require('./project-search');

const DEFAULT_LIMIT = 40;
const EXCERPT_RADIUS = 80;

function searchProjectLogs(outputsByProjectId, projects, query, options = {}) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const projectById = new Map((projects || []).map((project) => [project.id, project]));
  const results = [];
  for (const [projectId, rawOutput] of outputsByProjectId.entries()) {
    const project = projectById.get(projectId);
    if (!project) {
      continue;
    }
    const output = sanitizeProjectOutput(String(rawOutput || ''));
    if (!output) {
      continue;
    }
    const lines = output.split(/\r?\n/);
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toLocaleLowerCase().includes(normalizedQuery)) {
        continue;
      }
      matches.push({
        lineNumber: index + 1,
        excerpt: excerptAround(line, normalizedQuery)
      });
      if (matches.length >= 5) {
        break;
      }
    }
    if (!matches.length) {
      continue;
    }
    results.push({
      projectId,
      name: project.name,
      matchCount: matches.length,
      matches
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

function excerptAround(line, query) {
  const lower = line.toLocaleLowerCase();
  const index = lower.indexOf(query);
  if (index < 0) {
    return line.slice(0, EXCERPT_RADIUS * 2);
  }
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(line.length, index + query.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return `${prefix}${line.slice(start, end)}${suffix}`;
}

module.exports = {
  searchProjectLogs
};
