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
      return {
        action: 'handoff',
        disabled: busy,
        label: `Stop ${conflict.ownerName} and start ${name}`,
        mode: 'start'
      };
    }
    if (conflicted) {
      const port = conflict?.port || 'the configured port';
      return {
        action: 'force-close-ports-and-start',
        disabled: busy,
        label: `Close processes using port ${port} and start ${name}`,
        mode: 'start'
      };
    }

    const detectedWithoutStop = status === 'active' && !project.stopCommand;
    const ownershipLostWithoutStop = status === 'ownership-lost' && !project.stopCommand;
    if (detectedWithoutStop || ownershipLostWithoutStop) {
      return {
        action: 'force-close-ports',
        disabled: busy,
        label: `Close processes using ${name} ports`,
        mode: 'stop'
      };
    }

    const stopsProject = ['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active']
      .includes(status);
    return stopsProject
      ? { action: 'stop', disabled: busy, label: `Stop ${name}`, mode: 'stop' }
      : { action: 'start', disabled: busy, label: `Start ${name}`, mode: 'start' };
  }

  return { projectPrimaryAction };
}));
