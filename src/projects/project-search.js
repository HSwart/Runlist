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

module.exports = { normalizeSearchQuery, projectSearchText };
