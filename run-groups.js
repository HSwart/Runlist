const { ProcessOwnershipStore } = require('./project-process');

class RunGroupCoordinator {
  constructor(directory, options = {}) {
    this.ownership = new ProcessOwnershipStore(directory, options);
    this.held = new Set();
  }

  acquire(groupId) {
    const acquired = !this.ownership.reserve(groupId);
    if (acquired) {
      this.held.add(groupId);
    }
    return acquired;
  }

  release(groupId) {
    this.held.delete(groupId);
    return this.ownership.release(groupId);
  }

  dispose() {
    for (const groupId of [...this.held]) {
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
  try {
    for (let index = 0; index < group.projectIds.length; index += 1) {
      const projectId = group.projectIds[index];
      const project = projects.get(projectId);
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

      const status = options.getStatus(projectId);
      if (['running', 'active'].includes(status)) {
        notify(options, {
          status: 'skipped',
          project,
          index,
          total: group.projectIds.length
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
        total: group.projectIds.length
      });
      if (!await options.startProject(projectId)) {
        failedProjectId = projectId;
        failureReason = 'Runlist blocked or could not start this project.';
        break;
      }
      startedProjectIds.push(projectId);
      if (!await options.waitUntilReady(projectId)) {
        failedProjectId = projectId;
        failureReason = 'The project did not reach its ready state.';
        break;
      }
      notify(options, {
        status: 'ready',
        project,
        index,
        total: group.projectIds.length
      });
    }

    if (!failedProjectId) {
      notify(options, { status: 'started', total: group.projectIds.length });
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
  try {
    for (const projectId of [...group.projectIds].reverse()) {
      if (!options.isOwned(projectId)) {
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
      } catch {
        failedProjectIds.push(projectId);
      }
    }
    const status = failedProjectIds.length ? 'failed' : 'stopped';
    notify(options, { status, stoppedProjectIds, failedProjectIds });
    return { status, stoppedProjectIds, failedProjectIds };
  } finally {
    options.coordinator.release(group.id);
  }
}

async function runGroupManagementWorkflow(options) {
  try {
    let group = options.selectedGroupId
      ? options.groups.find((candidate) => candidate.id === options.selectedGroupId)
      : undefined;
    if (options.selectedGroupId && !group) {
      return { status: 'missing' };
    }
    if (!group) {
      const choice = await options.window.showQuickPick([
        {
          action: 'create',
          label: '$(add) Create run group',
          description: 'Choose projects in their startup order'
        },
        ...options.groups.map((candidate) => ({
          label: candidate.name,
          description: `${candidate.projectIds.length} project${candidate.projectIds.length === 1 ? '' : 's'}`,
          group: candidate
        }))
      ], {
        title: 'Manage Run Groups',
        placeHolder: 'Create or manage a saved group'
      });
      if (!choice) {
        return { status: 'cancelled' };
      }
      if (choice.action === 'create') {
        return editRunGroup(undefined, options);
      }
      group = choice.group;
    }

    const action = await options.window.showQuickPick([
      { action: 'start', label: '$(run-all) Start group' },
      { action: 'stop', label: '$(debug-stop) Stop group' },
      { action: 'edit', label: '$(edit) Edit projects and order' },
      { action: 'rename', label: '$(symbol-text) Rename group' },
      { action: 'remove', label: '$(trash) Remove group' }
    ], {
      title: group.name,
      placeHolder: 'Choose an action'
    });
    if (!action) {
      return { status: 'cancelled' };
    }
    if (action.action === 'start') {
      await options.startGroup?.(group.id);
      return { status: 'started' };
    }
    if (action.action === 'stop') {
      await options.stopGroup?.(group.id);
      return { status: 'stopped' };
    }
    if (action.action === 'edit') {
      return editRunGroup(group, options);
    }
    if (action.action === 'rename') {
      const name = await promptGroupName(options.window, group.name);
      if (!name) {
        return { status: 'cancelled' };
      }
      await options.saveGroup({ ...group, name });
      return { status: 'saved' };
    }

    const confirm = 'Remove group';
    const approved = await options.window.showWarningMessage(
      `Remove ${group.name}?`,
      { modal: true, detail: 'Saved projects and running processes are not changed.' },
      confirm
    );
    if (approved !== confirm) {
      return { status: 'cancelled' };
    }
    await options.removeGroup(group.id);
    return { status: 'removed' };
  } catch (error) {
    await options.window.showErrorMessage(`Could not manage run groups: ${error.message}`);
    return { status: 'error', error };
  }
}

async function editRunGroup(group, options) {
  if (!group && !options.projects.length) {
    await options.window.showInformationMessage('Add a project before creating a run group.');
    return { status: 'empty' };
  }
  let name = group?.name;
  if (!group) {
    name = await promptGroupName(options.window);
    if (!name) {
      return { status: 'cancelled' };
    }
  }
  const projectIds = [...(group?.projectIds || [])];
  const projectsById = new Map(options.projects.map((project) => [project.id, project]));
  while (true) {
    const available = options.projects.filter((project) => !projectIds.includes(project.id));
    const choices = [
      ...(projectIds.length ? [{
        action: 'save',
        label: '$(save) Save group',
        description: `${projectIds.length} project${projectIds.length === 1 ? '' : 's'}`
      }] : []),
      ...(available.length && projectIds.length < 20 ? [{
        action: 'add',
        label: '$(add) Add project',
        description: 'Append a saved project to the startup order'
      }] : []),
      ...projectIds.map((projectId, index) => ({
        action: 'member',
        projectId,
        label: `${index + 1}. ${projectsById.get(projectId)?.name || 'Missing project'}`,
        description: 'Move or remove'
      }))
    ];
    const choice = await options.window.showQuickPick(choices, {
      title: group ? `Edit ${group.name}` : `Create ${name}`,
      placeHolder: projectIds.length
        ? 'Add, reorder, remove, or save'
        : 'Add the first project'
    });
    if (!choice) {
      return { status: 'cancelled' };
    }
    if (choice.action === 'save') {
      await options.saveGroup({
        ...(group ? { id: group.id } : {}),
        name,
        projectIds
      });
      return { status: 'saved' };
    }
    if (choice.action === 'add') {
      const project = await options.window.showQuickPick(
        available.map((candidate) => ({
          label: candidate.name,
          description: candidate.folder,
          project: candidate
        })),
        { title: `Add to ${name}`, placeHolder: 'Choose the next project' }
      );
      if (project) {
        projectIds.push(project.project.id);
      }
      continue;
    }

    const index = projectIds.indexOf(choice.projectId);
    const memberAction = await options.window.showQuickPick([
      ...(index > 0 ? [{ action: 'move-up', label: '$(arrow-up) Move earlier' }] : []),
      ...(index < projectIds.length - 1 ? [{ action: 'move-down', label: '$(arrow-down) Move later' }] : []),
      { action: 'remove', label: '$(remove) Remove from group' }
    ], {
      title: projectsById.get(choice.projectId)?.name || name,
      placeHolder: 'Change this group member'
    });
    if (memberAction?.action === 'move-up') {
      [projectIds[index - 1], projectIds[index]] = [projectIds[index], projectIds[index - 1]];
    } else if (memberAction?.action === 'move-down') {
      [projectIds[index], projectIds[index + 1]] = [projectIds[index + 1], projectIds[index]];
    } else if (memberAction?.action === 'remove') {
      projectIds.splice(index, 1);
    }
  }
}

function promptGroupName(window, value) {
  return window.showInputBox({
    title: value ? 'Rename Run Group' : 'Create Run Group',
    prompt: 'Use a short name for this ordered set of projects.',
    value,
    validateInput: (name) => {
      const length = String(name || '').trim().length;
      return length >= 1 && length <= 100
        ? undefined
        : 'Enter a name containing 1 to 100 characters.';
    }
  }).then((name) => String(name || '').trim() || undefined);
}

function notify(options, progress) {
  options.onProgress?.(progress);
}

module.exports = {
  RunGroupCoordinator,
  runGroupManagementWorkflow,
  startRunGroup,
  stopRunGroup
};
