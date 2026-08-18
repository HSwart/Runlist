const { occupiedPortsBelongToProject } = require('./port-gate');
const {
  handoffProjectSafely,
  restartProjectSafely
} = require('./project-process');
const { stoppableProjectIds } = require('./project-status');
const { readProjects } = require('./project-store');
const { startRunGroup, stopRunGroup } = require('./run-groups');

/**
 * Owns lifecycle transition ordering. The view provider remains the adapter for
 * process mechanics, persisted state, rendering, and VS Code notifications.
 */
class ProjectLifecycleCoordinator {
  constructor(host, options = {}) {
    this.host = host;
    this.showWarningMessage = options.showWarningMessage || (() => undefined);
    this.showErrorMessage = options.showErrorMessage || (() => undefined);
    this.delay = options.delay || ((milliseconds) => new Promise((resolve) => (
      setTimeout(resolve, milliseconds)
    )));
    this.startReadinessTimeoutMs = options.startReadinessTimeoutMs ?? 30000;
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? 2000;
    this.remoteStopTimeoutMs = options.remoteStopTimeoutMs ?? 38000;
    this.servicePortStatus = options.servicePortStatus;
  }

  start(id, options = {}) {
    return this.host.startProjectProcess(id, options);
  }

  stop(id, projectSnapshot, options = {}) {
    return this.host.stopProjectProcess(id, projectSnapshot, options);
  }

  async startGroup(id) {
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

  async stopGroup(id) {
    const group = this.host.groups.find((candidate) => candidate.id === id);
    if (!group) {
      return false;
    }
    const result = await stopRunGroup(group, {
      coordinator: this.host.runGroupCoordinator,
      isOwned: (projectId) => {
        const project = this.host.projects.find((candidate) => candidate.id === projectId);
        return Boolean(project && stoppableProjectIds([{
          ...project,
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
      this.showErrorMessage(
        `Runlist could not confirm that every owned process in ${group.name} stopped.`
      );
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
    const deadline = Date.now() + timeoutMs;
    while (this.host.processOwnership.snapshot().has(id)
      || this.host.portReservations.snapshot().has(id)) {
      if (Date.now() >= deadline) {
        return false;
      }
      await this.delay(100);
    }
    this.host.remoteStopRequests.delete(id);
    this.host.stoppingProjectIds.delete(id);
    this.host.managedProjectIds.delete(id);
    this.host.projectStatuses.set(id, 'stopped');
    return true;
  }

  async handoff(id) {
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
          const reservationConflicts = this.host.portReservations.conflicts(latestRequestedProject);
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
          const portStatus = await this.servicePortStatus(latestRequestedProject.services || []);
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

  restart(id) {
    const project = this.host.projects.find((candidate) => candidate.id === id);
    if (!project) {
      return false;
    }
    return restartProjectSafely(this.host.restartingProjectIds, id, {
      canRestart: () => {
        const status = this.host.getProjectStatus(id);
        const sharedState = this.host.processOwnership.snapshot().get(id)?.state
          || this.host.portReservations.snapshot().get(id);
        return ['running', 'not-ready', 'not-responding', 'ownership-lost', 'active']
          .includes(status)
          && (!['active', 'ownership-lost'].includes(status) || Boolean(project.stopCommand))
          && !['starting', 'stopping'].includes(sharedState);
      },
      stop: () => this.host.stopProject(id),
      waitForStop: () => this.host.waitForProjectStopCompletion(id),
      start: () => this.host.startProject(id)
    });
  }

  stopAll() {
    const projects = this.host.projects.map((project) => ({
      ...project,
      status: this.host.getProjectStatus(project.id)
    }));
    for (const id of stoppableProjectIds(projects)) {
      void this.host.stopProject(id);
    }
  }
}

module.exports = { ProjectLifecycleCoordinator };
