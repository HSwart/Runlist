const MAX_DEPENDS_ON = 8;

function normalizeDependsOn(value, projectId, projectsById) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('dependsOn must be a list of project ids.');
  }
  if (value.length > MAX_DEPENDS_ON) {
    throw new Error(`dependsOn cannot list more than ${MAX_DEPENDS_ON} projects.`);
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('dependsOn entries must be project ids.');
    }
    const id = entry.trim();
    if (id === projectId) {
      throw new Error('A project cannot depend on itself.');
    }
    if (!projectsById.has(id)) {
      throw new Error('dependsOn references a project that is not saved in Runlist.');
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function dependencyCycleMessage(projectIds, dependsOnById) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(projectId) {
    if (visited.has(projectId)) {
      return undefined;
    }
    if (visiting.has(projectId)) {
      const cycleStart = stack.indexOf(projectId);
      const cycle = stack.slice(cycleStart).concat(projectId);
      const names = cycle.map((id) => dependsOnById.get(id)?.name || id);
      return `Dependency cycle detected: ${names.join(' → ')}`;
    }
    visiting.add(projectId);
    stack.push(projectId);
    for (const dependencyId of dependsOnById.get(projectId)?.dependsOn || []) {
      const message = visit(dependencyId);
      if (message) {
        return message;
      }
    }
    stack.pop();
    visiting.delete(projectId);
    visited.add(projectId);
    return undefined;
  }

  for (const projectId of projectIds) {
    const message = visit(projectId);
    if (message) {
      return message;
    }
  }
  return undefined;
}

function orderProjectsByDependencies(projectIds, projectsById) {
  const ids = [...new Set(projectIds.filter((id) => projectsById.has(id)))];
  const dependsOnById = new Map(ids.map((id) => [id, projectsById.get(id)]));
  const cycle = dependencyCycleMessage(ids, dependsOnById);
  if (cycle) {
    throw new Error(cycle);
  }
  const ordered = [];
  const pending = new Set(ids);
  while (pending.size) {
    let progressed = false;
    for (const projectId of [...pending]) {
      const dependencies = projectsById.get(projectId)?.dependsOn || [];
      if (dependencies.every((dependencyId) => ordered.includes(dependencyId))) {
        ordered.push(projectId);
        pending.delete(projectId);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error('Dependency cycle detected in this run group.');
    }
  }
  return ordered;
}

function unresolvedDependencies(project, projectsById, getStatus, when = 'ready') {
  const dependencies = Array.isArray(project?.dependsOn) ? project.dependsOn : [];
  const waiting = [];
  for (const dependencyId of dependencies) {
    const dependency = projectsById.get(dependencyId);
    if (!dependency) {
      waiting.push({ projectId: dependencyId, name: 'missing project', status: 'missing' });
      continue;
    }
    const status = getStatus(dependencyId);
    const ready = when === 'started'
      ? ['running', 'active', 'not-ready', 'not-responding', 'starting'].includes(status)
      : ['running', 'active'].includes(status);
    if (!ready) {
      waiting.push({ projectId: dependencyId, name: dependency.name, status });
    }
  }
  return waiting;
}

module.exports = {
  MAX_DEPENDS_ON,
  dependencyCycleMessage,
  normalizeDependsOn,
  orderProjectsByDependencies,
  unresolvedDependencies
};
