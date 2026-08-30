const { occupiedPortsBelongToProject } = require('../ports/port-gate');
const {
  handoffProjectSafely,
  projectStopStrategy,
  restartProjectSafely
} = require('./project-process');
const { stoppableProjectIds } = require('./project-status');
const { readProjects } = require('../projects/project-store');
const { startRunGroup, stopRunGroup } = require('../groups/run-groups');

/**
 * Owns lifecycle transition ordering. The view provider remains the adapter for
 * process mechanics, persisted state, rendering, and VS Code notifications.
 */
class ProjectLifecycleCoordinator {
  constructor(host, options = {}) {
    this.host = host;
    this.showWarningMessage = options.showWarningMessage || (() => undefined);
    this.showErrorMessage = options.showErrorMessage || (() => undefined);
    this.now = options.now || Date.now;
    this.delay = options.delay || ((milliseconds) => new Promise((resolve) => (
      setTimeout(resolve, milliseconds)
    )));
    this.startReadinessTimeoutMs = options.startReadinessTimeoutMs ?? 30000;
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? 2000;
    this.remoteStopTimeoutMs = options.remoteStopTimeoutMs ?? 38000;
    this.servicePortStatus = options.servicePortStatus;
    this.isServiceReady = options.isServiceReady || (async (service) => (
      await this.servicePortStatus([service])
    ).allOpen);
    this.operations = new Set();
    this.shuttingDown = false;
  }

  start(id, options = {}) {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }
    return this.track(this.host.startProjectProcess(id, options));
  }

  stop(id, projectSnapshot, options = {}) {
    return this.track(this.host.stopProjectProcess(id, projectSnapshot, options));
  }

  beginShutdown() {
    this.shuttingDown = true;
  }

  async waitForIdle() {
    while (this.operations.size) {
      await Promise.allSettled([...this.operations]);
    }
  }

  track(operation) {
    const promise = Promise.resolve(operation);
    this.operations.add(promise);
    void promise.finally(() => this.operations.delete(promise)).catch(() => undefined);
    return promise;
  }

  startGroup(id) {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }
    return this.track(this.startGroupOperation(id));
  }

  async startGroupOperation(id) {
    const group = this.host.groups.find((candidate) => candidate.id === id);
    if (!group) {
      return false;
    }
    const result = await startRunGroup(group, {
      coordinator: this.host.runGroupCoordinator,
      projects: readProjects(this.host.projectsFile),
      getStatus: (projectId) => this.host.getProjectStatus(projectId),
      startProject: (projectId) => this.host.startProject(projectId),
      waitUntilReady: (projectId) => this.host.waitForProjectReady(projectId),
      stopProject: (projectId) => this.host.stopProject(projectId),
      waitUntilStopped: (projectId) => this.host.waitForProjectStopCompletion(projectId),
      onProgress: (progress) => this.host.updateRunGroupProgress(group, progress)
    });
    if (result.status === 'busy') {
      this.host.runGroupStates.set(id, {
        busy: false,
        message: 'This group is already changing in another VS Code window.'
      });
      this.showWarningMessage(`${group.name} is already starting or stopping in another VS Code window.`);
      this.host.renderProjectList();
    } else if (result.status === 'failed') {
      const failedProject = readProjects(this.host.projectsFile)
        .find((project) => project.id === result.failedProjectId);
      const rollbackWarning = result.rollbackFailures?.length
        ? ' Some processes could not be confirmed stopped.'
        : '';
      this.showErrorMessage(
        `${group.name} stopped at ${failedProject?.name || 'a missing project'}. ${result.failureReason}${rollbackWarning}`
      );
    }
    return result.status === 'started';
  }

  stopGroup(id) {
    return this.track(this.stopGroupOperation(id));
  }

  async stopGroupOperation(id) {
    const group = this.host.groups.find((candidate) => candidate.id === id);
    if (!group) {
      return false;
    }
    const result = await stopRunGroup(group, {
      coordinator: this.host.runGroupCoordinator,
      isOwned: (projectId) => {
        const project = this.host.projects.find((candidate) => candidate.id === projectId);
        const runtimeProject = projectStopStrategy(
          project,
          this.host.processOwnership.snapshot().get(projectId)
        );
        return Boolean(runtimeProject && stoppableProjectIds([{
          ...runtimeProject,
          status: this.host.getProjectStatus(projectId)
        }]).length);
      },
      stopProject: (projectId) => this.host.stopProject(projectId),
      waitUntilStopped: (projectId) => this.host.waitForProjectStopCompletion(projectId),
      onProgress: (progress) => this.host.updateRunGroupProgress(group, progress)
    });
    if (result.status === 'busy') {
      this.host.runGroupStates.set(id, {
        busy: false,
        message: 'This group is already changing in another VS Code window.'
      });
      this.showWarningMessage(`${group.name} is already starting or stopping in another VS Code window.`);
      this.host.renderProjectList();
    } else if (result.status === 'failed') {
      const failedProject = readProjects(this.host.projectsFile)
        .find((project) => project.id === result.failedProjectId);
      if (result.failureReason && result.failedProjectId) {
        this.showErrorMessage(
          `${group.name} stopped at ${failedProject?.name || 'a missing project'}. ${result.failureReason}`
        );
      } else if (result.failureReason) {
        this.showErrorMessage(`Could not finish stopping ${group.name}: ${result.failureReason}`);
      } else if (result.failedProjectId) {
        this.showErrorMessage(
          `Runlist could not confirm that ${failedProject?.name || 'a project'} in ${group.name} stopped.`
        );
      } else {
        this.showErrorMessage(
          `Runlist could not confirm that every owned process in ${group.name} stopped.`
        );
      }
    }
    return result.status === 'stopped';
  }

  async waitUntilReady(id) {
    const deadline = Date.now()
      + this.startReadinessTimeoutMs
      + (this.statusPollIntervalMs * 2);
    while (Date.now() < deadline) {
      await this.host.refreshProjectStatuses();
      const status = this.host.getProjectStatus(id);
      if (status === 'running') {
        return true;
      }
      if (['stopped', 'not-ready', 'not-responding', 'ownership-lost', 'active', 'port-in-use', 'port-in-use-unknown']
        .includes(status)) {
        return false;
      }
      await this.delay(100);
    }
    return false;
  }

  async waitUntilStopped(id, timeoutMs = this.remoteStopTimeoutMs + 1000) {
    const deadline = this.now() + timeoutMs;
    while (true) {
      const localProcessPresent = Boolean(this.host.processes?.has?.(id));
      const ownershipPresent = this.host.processOwnership.snapshot().has(id)
        || this.host.portReservations.snapshot().has(id);
      const project = (this.host.projects || []).find((item) => item.id === id);
      if (!localProcessPresent && !ownershipPresent) {
        const remainingMs = Math.max(0, deadline - this.now());
        const servicesStopped = await this.waitUntilServicesStopped(
          project,
          Math.min(remainingMs, 100)
        );
        if (servicesStopped) {
          this.host.remoteStopRequests.delete(id);
          this.host.stoppingProjectIds.delete(id);
          this.host.managedProjectIds.delete(id);
          this.host.projectStatuses.set(id, 'stopped');
          if (this.host.projectStopFailures instanceof Map) {
            this.host.projectStopFailures.delete(id);
          }
          return true;
        }
      }
      if (this.now() >= deadline) {
        return false;
      }
      await this.delay(100);
    }
  }

  async waitUntilServicesStopped(project, timeoutMs = 20000) {
    if (!project?.services?.length || typeof this.servicePortStatus !== 'function') {
      return true;
    }
    const deadline = this.now() + timeoutMs;
    while (true) {
      const status = await this.servicePortStatus(project.services);
      if (!status.anyOpen) {
        return true;
      }
      if (this.now() >= deadline) {
        return false;
      }
      await this.delay(100);
    }
  }

  async waitUntilServiceReady(service, timeoutMs = this.startReadinessTimeoutMs, shouldContinue) {
    const deadline = this.now() + timeoutMs;
    while (true) {
      if (shouldContinue && !shouldContinue()) {
        return false;
      }
      const ready = await this.isServiceReady(service);
      if (shouldContinue && !shouldContinue()) {
        return false;
      }
      if (ready) {
        return true;
      }
      if (this.now() >= deadline) {
        return false;
      }
      await this.delay(100);
    }
  }

  handoff(id) {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }
    return this.track(this.handoffOperation(id));
  }

  async handoffOperation(id) {
    const requestedProject = this.host.projects.find((project) => project.id === id);
    if (!requestedProject || requestedProject.reviewRequired) {
      return false;
    }

    let conflictOwnerName = 'the conflicting project';
    let failureMessage;
    let succeeded = false;
    try {
      succeeded = await handoffProjectSafely(this.host.handoffProjectIds, id, {
        reserveRequested: () => {
          const reservationConflict = this.host.processOwnership.reserve(id);
          if (!reservationConflict) {
            return true;
          }
          failureMessage = reservationConflict.kind === 'uncertain'
            ? `Runlist cannot safely verify ${requestedProject.name}'s current ownership. Nothing was stopped.`
            : `${requestedProject.name} is already starting or running in another VS Code window.`;
          return false;
        },
        currentConflict: async () => {
          const projects = this.host.projects;
          const latestRequestedProject = projects.find((project) => project.id === id);
          if (!latestRequestedProject || latestRequestedProject.reviewRequired) {
            failureMessage = `${requestedProject.name}'s setup changed before Runlist could switch projects. Nothing was stopped.`;
            return undefined;
          }
          const effectiveRequestedProject = projectStopStrategy(latestRequestedProject);
          const reservationConflicts = this.host.portReservations.conflicts(effectiveRequestedProject);
          const ownerIds = new Set(reservationConflicts.map((conflict) => conflict.projectId));
          if (reservationConflicts.length === 0 || ownerIds.size !== 1) {
            failureMessage = reservationConflicts.length > 1
              ? `${requestedProject.name} now conflicts with more than one project. Runlist did not stop anything.`
              : `The port conflict for ${requestedProject.name} changed before Runlist could switch projects. Nothing was stopped.`;
            return undefined;
          }
          const ownerId = reservationConflicts[0].projectId;
          const owner = projects.find((project) => project.id === ownerId);
          const ownership = this.host.processOwnership.snapshot().get(ownerId);
          const portStatus = await this.servicePortStatus(effectiveRequestedProject.services || []);
          conflictOwnerName = owner?.name || conflictOwnerName;
          if (!owner
            || !ownership?.ownerAvailable
            || !ownership.processActive
            || ownership.state === 'stopping'
            || !occupiedPortsBelongToProject(
              portStatus.openPorts,
              reservationConflicts,
              ownerId
            )) {
            failureMessage = `Runlist can no longer verify that ${conflictOwnerName} owns the conflicting process. Nothing was stopped.`;
            return undefined;
          }
          return { owner, ownership };
        },
        stop: (conflict) => this.host.stopProject(conflict.owner.id, undefined, {
          expectedOwnershipToken: conflict.ownership.token
        }),
        waitForStop: async (conflict) => {
          const stopped = await this.host.waitForProjectStopCompletion(conflict.owner.id);
          if (!stopped) {
            failureMessage = `Runlist could not confirm that ${conflict.owner.name} stopped, so ${requestedProject.name} was not started.`;
          }
          return stopped;
        },
        start: () => this.host.startProject(id, {
          allowPortConflict: true,
          ownershipReserved: true
        }),
        releaseRequested: () => this.host.processOwnership.release(id)
      });
    } catch (error) {
      failureMessage = `Could not switch to ${requestedProject.name}: ${error.message}`;
    }

    if (!succeeded && failureMessage) {
      this.showErrorMessage(failureMessage);
    }
    this.host.focusTarget = succeeded
      ? { type: 'project-control', id }
      : { type: 'action', action: 'handoff', id };
    this.host.renderProjectList();
    void this.host.refreshProjectStatuses();
    return succeeded;
  }

  restart(id, options = {}) {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }
    const project = this.host.projects.find((candidate) => candidate.id === id);
    if (!project) {
      return false;
    }
    const ownership = this.host.processOwnership.snapshot().get(id);
    const runtimeProject = projectStopStrategy(project, ownership);
    const portOverrides = options.portOverrides || ownership?.portOverrides;
    return this.track(restartProjectSafely(this.host.restartingProjectIds, id, {
      canRestart: () => {
        const status = this.host.getProjectStatus(id);
        const sharedState = this.host.processOwnership.snapshot().get(id)?.state
          || this.host.portReservations.snapshot().get(id);
        return ['running', 'not-ready', 'not-responding', 'ownership-lost', 'active', 'stopping']
          .includes(status)
          && (!['active', 'ownership-lost'].includes(status) || Boolean(runtimeProject.stopCommand))
          && sharedState !== 'starting';
      },
      stop: () => this.host.stopProject(id, runtimeProject),
      waitForStop: () => this.host.waitForProjectStopCompletion(id),
      start: () => this.host.startProject(id, {
        ...(portOverrides?.length ? { allowPortConflict: true, portOverrides } : {})
      })
    }));
  }

  stopAll() {
    const ownership = this.host.processOwnership.snapshot();
    const projects = this.host.projects.map((project) => ({
      ...projectStopStrategy(project, ownership.get(project.id)),
      status: this.host.getProjectStatus(project.id)
    }));
    for (const id of stoppableProjectIds(projects)) {
      void this.host.stopProject(id, projects.find((project) => project.id === id));
    }
  }
}

function stopAllConfirmation(stoppableCount) {
  return {
    message: 'Stop all running projects?',
    confirmLabel: 'Stop all',
    detail: [
      `This stops ${stoppableCount} running projects that Runlist started in this VS Code window.`,
      '',
      'Runlist does not stop external listeners or apps running in other VS Code windows.',
      '',
      'Are you sure you want to continue?'
    ].join('\n')
  };
}

function stopGroupConfirmation({ groupName, stoppableCount, projectNames = [] }) {
  const boundedNames = (projectNames || [])
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const extraNames = Math.max(0, (projectNames || []).length - boundedNames.length);
  const nameLines = boundedNames.length
    ? [
      '',
      boundedNames.join('\n'),
      ...(extraNames ? [`…and ${extraNames} more.`] : [])
    ].join('\n')
    : '';
  const projectLabel = stoppableCount === 1 ? 'project' : 'projects';
  return {
    message: `Stop group ${groupName}?`,
    confirmLabel: 'Stop group',
    detail: [
      `This stops ${stoppableCount} running ${projectLabel} that Runlist controls in this group from this window.`,
      'Projects already stopped, running elsewhere, or without a stop command are skipped.',
      'External listeners are not closed.',
      nameLines
    ].filter(Boolean).join('\n')
  };
}

module.exports = {
  ProjectLifecycleCoordinator,
  stopAllConfirmation,
  stopGroupConfirmation
};
