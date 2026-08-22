function normalizeSearchQuery(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function projectSearchText(project) {
  return normalizeSearchQuery([
    project.name,
    project.folder,
    ...(Array.isArray(project.tags) ? project.tags : [])
  ].filter(Boolean).join('\n'));
}

function projectMatchesQuery(project, query) {
  const normalizedQuery = normalizeSearchQuery(query);
  return !normalizedQuery || projectSearchText(project).includes(normalizedQuery);
}

module.exports = { normalizeSearchQuery, projectSearchText, projectMatchesQuery };
