(function exposeProjectActions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.RunlistProjectActions = api;
  }
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function projectPrimaryAction(project = {}) {
    const name = String(project.name || 'project');
    const status = String(project.status || 'stopped');
    const busy = project.forceClosing === true || project.handoffInProgress === true;
    if (project.reviewRequired) {
      return {
        action: 'edit',
        disabled: busy,
        label: `Review setup for ${name}`,
        mode: 'review'
      };
    }
    if (project.lifecycleBlocked) {
      return {
        action: 'start',
        disabled: true,
        label: project.lifecycleBlockedReason || `Lifecycle controls are unavailable for ${name}`,
        mode: 'start'
      };
    }
    if (status === 'stopping') {
      return {
        action: 'stop',
        disabled: true,
        label: `Stopping ${name}`,
        mode: 'stop'
      };
    }

    const conflict = project.portConflict;
    const conflicted = ['port-in-use', 'port-in-use-unknown'].includes(status);
    if (conflicted && conflict?.handoffAvailable && conflict?.ownerName) {
      return composeStartGate(project, {
        action: 'handoff',
        disabled: busy,
        label: `Stop ${conflict.ownerName} and start ${name}`,
        mode: 'start'
      });
    }
    if (status === 'port-in-use') {
      const owner = conflict?.ownerName || 'the conflicting Runlist project';
      return composeStartGate(project, {
        action: 'start',
        disabled: true,
        label: `Stop ${owner} and any other Runlist port owners before starting ${name}`,
        mode: 'start'
      });
    }
    if (conflicted) {
      const port = conflict?.port || 'the configured port';
      return composeStartGate(project, {
        action: 'force-close-ports-and-start',
        disabled: busy,
        label: `Close processes using port ${port} and start ${name}`,
        mode: 'start'
      });
    }

    const detectedWithoutStop = status === 'active' && !project.stopCommand;
    const ownershipLostWithoutStop = status === 'ownership-lost' && !project.stopCommand;
    if ((detectedWithoutStop || ownershipLostWithoutStop) && !project.stopFailure) {
      return {
        action: 'force-close-ports',
        disabled: busy,
        label: `Close processes using ${name} ports`,
        mode: 'stop'
      };
    }

    const stopsProject = (Boolean(project.stopFailure) && status !== 'stopped' && status !== 'stopping')
      || ['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active']
        .includes(status);
    const primary = stopsProject
      ? { action: 'stop', disabled: busy, label: `Stop ${name}`, mode: 'stop' }
      : { action: 'start', disabled: busy, label: `Start ${name}`, mode: 'start' };
    return composeStartGate(project, primary);
  }

  function composeStartGate(project, primary) {
    if (!project.composeStartBlocked || primary.mode !== 'start') {
      return primary;
    }
    const name = String(project.name || 'project');
    return {
      action: 'start',
      disabled: true,
      label: project.composeStartBlockedReason
        || `Start is unavailable for ${name} until Docker is ready`,
      mode: 'start'
    };
  }

  return { projectPrimaryAction };
}));
