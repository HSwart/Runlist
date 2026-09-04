const { ProcessOwnershipStore } = require('../lifecycle/project-process');
const {
  dependencyLayers,
  orderProjectsByDependencies,
  unresolvedDependencies
} = require('../projects/project-dependencies');

class RunGroupCoordinator {
  constructor(directory, options = {}) {
    this.ownership = new ProcessOwnershipStore(directory, options);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2000;
    this.onLeaseLost = options.onLeaseLost || (() => undefined);
    this.held = new Map();
    this.lost = new Set();
  }

  acquire(groupId) {
    const acquired = !this.ownership.reserve(groupId);
    if (acquired) {
      this.lost.delete(groupId);
      const timer = setInterval(() => this.renew(groupId), this.heartbeatIntervalMs);
      timer.unref?.();
      this.held.set(groupId, timer);
    }
    return acquired;
  }

  renew(groupId) {
    if (!this.held.has(groupId) || this.lost.has(groupId)) {
      return false;
    }
    try {
      const renewed = this.ownership.setState(groupId, 'running');
      if (!renewed) {
        this.markLeaseLost(groupId, 'ownership-changed');
      }
      return renewed;
    } catch (error) {
      this.markLeaseLost(groupId, 'heartbeat-failed', error);
      return false;
    }
  }

  hasLease(groupId) {
    return this.held.has(groupId) && !this.lost.has(groupId);
  }

  markLeaseLost(groupId, reason, error) {
    if (this.lost.has(groupId)) {
      return;
    }
    clearInterval(this.held.get(groupId));
    this.held.delete(groupId);
    this.lost.add(groupId);
    try {
      this.onLeaseLost({ error, groupId, reason });
    } catch {
      // Reporting must not turn a lost coordination lease into an uncaught timer error.
    }
  }

  release(groupId) {
    clearInterval(this.held.get(groupId));
    this.held.delete(groupId);
    try {
      const released = this.ownership.release(groupId);
      this.lost.delete(groupId);
      return released;
    } catch (error) {
      this.lost.add(groupId);
      try {
        this.onLeaseLost({ error, groupId, reason: 'release-failed' });
      } catch {
        // Reporting must not override the group operation result.
      }
      return false;
    }
  }

  dispose() {
    for (const groupId of new Set([...this.held.keys(), ...this.lost])) {
      this.release(groupId);
    }
  }
}

async function startRunGroup(group, options) {
  if (!options.coordinator.acquire(group.id)) {
    return { status: 'busy', startedProjectIds: [] };
  }

  const projects = new Map(options.projects.map((project) => [project.id, project]));
  const startedProjectIds = [];
  let failedProjectId;
  let failureReason;
  let orderedProjectIds;
  try {
    try {
      orderedProjectIds = orderProjectsByDependencies(group.projectIds, projects);
    } catch (error) {
      notify(options, { status: 'failed', reason: error.message, rollbackFailures: [] });
      return {
        status: 'failed',
        startedProjectIds,
        failedProjectId: group.projectIds[0],
        failureReason: error.message,
        rollbackFailures: []
      };
    }
    const groupProjectIds = new Set(group.projectIds);
    if (group.startMode === 'parallel') {
      return await startRunGroupInParallel({
        ...group,
        projectIds: orderedProjectIds
      }, options, projects, startedProjectIds);
    }
    for (let index = 0; index < orderedProjectIds.length; index += 1) {
      const projectId = orderedProjectIds[index];
      const project = projects.get(projectId);
      if (!groupLeaseIsHeld(options.coordinator, group.id)) {
        failedProjectId = projectId;
        failureReason = groupLeaseLostReason();
        break;
      }
      if (!project) {
        failedProjectId = projectId;
        failureReason = 'The saved project is no longer available.';
        break;
      }
      if (project.reviewRequired) {
        failedProjectId = projectId;
        failureReason = 'Review and approve this project setup before running it.';
        break;
      }
      const dependencyFailure = dependencyStartFailure(
        project,
        groupProjectIds,
        projects,
        options.getStatus
      );
      if (dependencyFailure) {
        failedProjectId = projectId;
        failureReason = dependencyFailure;
        break;
      }

      const status = options.getStatus(projectId);
      if (['running', 'active'].includes(status)) {
        notify(options, {
          status: 'skipped',
          project,
          index,
          total: orderedProjectIds.length
        });
        continue;
      }
      if (status !== 'stopped') {
        failedProjectId = projectId;
        failureReason = `The project is ${status || 'not ready'} and cannot be started safely.`;
        break;
      }

      notify(options, {
        status: 'starting',
        project,
        index,
        total: orderedProjectIds.length
      });
      if (!await options.startProject(projectId)) {
        failedProjectId = projectId;
        failureReason = 'Runlist blocked or could not start this project.';
        break;
      }
      startedProjectIds.push(projectId);
      if (!groupLeaseIsHeld(options.coordinator, group.id)) {
        failedProjectId = projectId;
        failureReason = groupLeaseLostReason();
        break;
      }
      const ready = await options.waitUntilReady(projectId);
      if (!groupLeaseIsHeld(options.coordinator, group.id)) {
        failedProjectId = projectId;
        failureReason = groupLeaseLostReason();
        break;
      }
      if (!ready) {
        failedProjectId = projectId;
        failureReason = 'The project did not reach its ready state.';
        break;
      }
      notify(options, {
        status: 'ready',
        project,
        index,
        total: orderedProjectIds.length
      });
    }

    if (!failedProjectId) {
      notify(options, { status: 'started', total: orderedProjectIds.length });
      return { status: 'started', startedProjectIds };
    }

    const rollbackFailures = await rollbackStartedProjects(startedProjectIds, options);
    notify(options, {
      status: 'failed',
      project: projects.get(failedProjectId),
      reason: failureReason,
      rollbackFailures
    });
    return {
      status: 'failed',
      startedProjectIds,
      failedProjectId,
      failureReason,
      rollbackFailures
    };
  } catch (error) {
    const rollbackFailures = await rollbackStartedProjects(startedProjectIds, options);
    notify(options, { status: 'failed', reason: error.message, rollbackFailures });
    return {
      status: 'failed',
      startedProjectIds,
      failedProjectId,
      failureReason: error.message,
      rollbackFailures
    };
  } finally {
    options.coordinator.release(group.id);
  }
}

async function startRunGroupInParallel(group, options, projects, startedProjectIds) {
  let layers;
  try {
    layers = dependencyLayers(group.projectIds, projects);
  } catch (error) {
    notify(options, { status: 'failed', reason: error.message, rollbackFailures: [] });
    return {
      status: 'failed',
      startedProjectIds,
      failedProjectId: group.projectIds[0],
      failureReason: error.message,
      rollbackFailures: []
    };
  }

  for (const layerProjectIds of layers) {
    for (const projectId of layerProjectIds) {
      const project = projects.get(projectId);
      const status = options.getStatus(projectId);
      const failureReason = parallelPreflightFailure(
        project,
        status,
        new Set(group.projectIds),
        projects,
        options.getStatus
      );
      if (failureReason) {
        notify(options, { status: 'failed', project, reason: failureReason, rollbackFailures: [] });
        return {
          status: 'failed',
          startedProjectIds,
          failedProjectId: projectId,
          failedProjectIds: [projectId],
          failureReason,
          rollbackFailures: []
        };
      }
    }
  }

  for (const layerProjectIds of layers) {
    const eligible = [];
    for (let index = 0; index < layerProjectIds.length; index += 1) {
      const projectId = layerProjectIds[index];
      const project = projects.get(projectId);
      const status = options.getStatus(projectId);
      if (['running', 'active'].includes(status)) {
        notify(options, {
          status: 'skipped',
          project,
          index: group.projectIds.indexOf(projectId),
          total: group.projectIds.length,
          mode: 'parallel'
        });
      } else {
        eligible.push({ project, projectId, index: group.projectIds.indexOf(projectId) });
      }
    }

    if (!eligible.length) {
      continue;
    }

    notify(options, {
      status: 'starting-parallel',
      total: group.projectIds.length,
      eligibleTotal: eligible.length,
      mode: 'parallel'
    });
    let readyCount = 0;
    const results = await Promise.all(eligible.map(async ({ project, projectId, index }) => {
      try {
        if (!groupLeaseIsHeld(options.coordinator, group.id)) {
          return { projectId, reason: groupLeaseLostReason() };
        }
        const started = await options.startProject(projectId);
        if (!started) {
          return { projectId, reason: 'Runlist blocked or could not start this project.' };
        }
        startedProjectIds.push(projectId);
        if (!groupLeaseIsHeld(options.coordinator, group.id)) {
          return { projectId, reason: groupLeaseLostReason() };
        }
        const ready = await options.waitUntilReady(projectId);
        if (!groupLeaseIsHeld(options.coordinator, group.id)) {
          return { projectId, reason: groupLeaseLostReason() };
        }
        if (!ready) {
          return { projectId, reason: 'The project did not reach its ready state.' };
        }
        readyCount += 1;
        notify(options, {
          status: 'parallel-progress',
          project,
          index,
          total: group.projectIds.length,
          eligibleTotal: eligible.length,
          readyCount,
          mode: 'parallel'
        });
        return { projectId };
      } catch (error) {
        return { projectId, reason: error.message };
      }
    }));

    const failures = results.filter((result) => result.reason);
    if (failures.length) {
      const orderedStartedIds = orderedProjectIds(group, startedProjectIds);
      const rollbackFailures = await rollbackStartedProjects(orderedStartedIds, options);
      const firstFailure = failures
        .sort((left, right) => group.projectIds.indexOf(left.projectId) - group.projectIds.indexOf(right.projectId))[0];
      notify(options, {
        status: 'failed',
        project: projects.get(firstFailure.projectId),
        reason: firstFailure.reason,
        rollbackFailures
      });
      return {
        status: 'failed',
        startedProjectIds: orderedStartedIds,
        failedProjectId: firstFailure.projectId,
        failedProjectIds: failures.map((failure) => failure.projectId),
        failureReason: firstFailure.reason,
        rollbackFailures
      };
    }
  }

  notify(options, { status: 'started', total: group.projectIds.length, mode: 'parallel' });
  return { status: 'started', startedProjectIds: orderedProjectIds(group, startedProjectIds) };
}

function parallelPreflightFailure(project, status, groupProjectIds, projectsById, getStatus) {
  if (!project) {
    return 'The saved project is no longer available.';
  }
  if (project.reviewRequired) {
    return 'Review and approve this project setup before running it.';
  }
  const dependencyFailure = dependencyStartFailure(
    project,
    groupProjectIds,
    projectsById,
    getStatus
  );
  if (dependencyFailure) {
    return dependencyFailure;
  }
  if (!['stopped', 'running', 'active'].includes(status)) {
    return `The project is ${status || 'not ready'} and cannot be started safely.`;
  }
  return undefined;
}

function dependencyStartFailure(project, groupProjectIds, projectsById, getStatus) {
  const waiting = unresolvedDependencies(project, projectsById, getStatus);
  if (!waiting.length) {
    return undefined;
  }
  const external = waiting.filter((entry) => !groupProjectIds.has(entry.projectId));
  if (!external.length) {
    return undefined;
  }
  const names = external.map((entry) => entry.name).join(', ');
  return external.length === 1
    ? `Start ${names} before ${project.name}.`
    : `Start these projects before ${project.name}: ${names}.`;
}

function orderedProjectIds(group, projectIds) {
  const included = new Set(projectIds);
  return group.projectIds.filter((projectId) => included.has(projectId));
}

async function rollbackStartedProjects(startedProjectIds, options) {
  const failures = [];
  for (const projectId of [...startedProjectIds].reverse()) {
    notify(options, { status: 'rolling-back', projectId });
    try {
      const requested = await options.stopProject(projectId);
      const stopped = requested && await options.waitUntilStopped(projectId);
      if (!stopped) {
        failures.push(projectId);
      }
    } catch {
      failures.push(projectId);
    }
  }
  return failures;
}

async function stopRunGroup(group, options) {
  if (!options.coordinator.acquire(group.id)) {
    return { status: 'busy', stoppedProjectIds: [] };
  }

  const stoppedProjectIds = [];
  const failedProjectIds = [];
  const skippedProjectIds = [];
  let coordinationLost = false;
  const stopOrder = stopOrderProjectIds(group, options);
  try {
    for (const projectId of stopOrder) {
      if (!groupLeaseIsHeld(options.coordinator, group.id)) {
        coordinationLost = true;
        break;
      }
      if (!options.isOwned(projectId)) {
        skippedProjectIds.push(projectId);
        continue;
      }
      notify(options, { status: 'stopping', projectId });
      try {
        const requested = await options.stopProject(projectId);
        const stopped = requested && await options.waitUntilStopped(projectId);
        if (stopped) {
          stoppedProjectIds.push(projectId);
        } else {
          failedProjectIds.push(projectId);
        }
        if (!groupLeaseIsHeld(options.coordinator, group.id)) {
          coordinationLost = true;
          break;
        }
      } catch {
        failedProjectIds.push(projectId);
      }
    }
    const status = failedProjectIds.length || coordinationLost ? 'failed' : 'stopped';
    const failedProjectId = failedProjectIds[0];
    const failureReason = coordinationLost
      ? groupLeaseLostReason()
      : (failedProjectIds.length ? 'Runlist could not confirm this project stopped.' : undefined);
    notify(options, {
      status,
      projectId: failedProjectId,
      stoppedProjectIds,
      failedProjectIds,
      ...(failureReason ? { reason: failureReason } : {})
    });
    return {
      status,
      stoppedProjectIds,
      failedProjectIds,
      skippedProjectIds,
      ...(failedProjectId ? { failedProjectId } : {}),
      ...(failureReason ? { failureReason } : {})
    };
  } finally {
    options.coordinator.release(group.id);
  }
}

function stopOrderProjectIds(group, options) {
  const projects = options.projects;
  if (!Array.isArray(projects) || !projects.length) {
    return [...group.projectIds].reverse();
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  try {
    return [...orderProjectsByDependencies(group.projectIds, projectsById)].reverse();
  } catch {
    return [...group.projectIds].reverse();
  }
}

function groupLeaseIsHeld(coordinator, groupId) {
  return typeof coordinator.hasLease !== 'function' || coordinator.hasLease(groupId);
}

function groupLeaseLostReason() {
  return 'Runlist lost cross-window coordination for this group.';
}

function notify(options, progress) {
  options.onProgress?.(progress);
}

module.exports = {
  RunGroupCoordinator,
  startRunGroup,
  stopRunGroup
};
