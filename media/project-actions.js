(function exposeProjectActions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.RunlistProjectActions = api;
  }
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function projectHasLiveFolderStatus(project = {}) {
    const status = String(project.status || 'stopped');
    return project.forceClosing === true
      || project.handoffInProgress === true
      || ['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active', 'stopping']
        .includes(status);
  }

  function projectCanRelinkFolder(project = {}) {
    if (project.reviewRequired || project.folderAccessible !== false) {
      return false;
    }
    if (typeof project.composePath === 'string' && project.composePath.trim()) {
      return false;
    }
    return !projectHasLiveFolderStatus(project);
  }

  function isMissingRequiredEnvFailure(failure = {}) {
    if (!failure || typeof failure !== 'object') {
      return false;
    }
    return failure.kind === 'missing-required-env'
      || failure.failureKind === 'missing-required-env';
  }

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
    const detectedWithoutStop = status === 'active' && !project.stopCommand;
    const ownershipLostWithoutStop = status === 'ownership-lost' && !project.stopCommand;
    if ((detectedWithoutStop || ownershipLostWithoutStop) && !project.stopFailure) {
      return {
        action: 'add-stop-command',
        disabled: busy,
        label: `Add a stop command for ${name}`,
        mode: 'edit'
      };
    }

    if (project.lifecycleBlocked && project.folderAccessible !== false) {
      return {
        action: 'start',
        disabled: true,
        label: project.lifecycleBlockedReason || `Lifecycle controls are unavailable for ${name}`,
        mode: 'start'
      };
    }
    if (status === 'stopped' && isMissingRequiredEnvFailure(project.failureSummary)) {
      return {
        action: 'fix-environment',
        disabled: busy,
        label: `Fix environment setup for ${name}`,
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
      const primary = {
        action: 'resolve-port-conflict',
        disabled: busy,
        label: `See what's using port ${port} for ${name}`,
        mode: 'start'
      };
      const numericPort = Number(conflict?.port);
      if (Number.isInteger(numericPort) && numericPort >= 1 && numericPort <= 65535) {
        primary.port = numericPort;
      }
      return composeStartGate(project, primary);
    }

    const hasRetainedStopFailure = Boolean(String(project.stopFailure || '').trim())
      && status !== 'stopped'
      && status !== 'stopping';
    const stopsProject = hasRetainedStopFailure
      || ['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active']
        .includes(status);
    if (stopsProject) {
      if (hasRetainedStopFailure && !busy) {
        return {
          action: 'output',
          disabled: false,
          label: `View output for ${name}`,
          mode: 'output'
        };
      }
      const unresponsiveWeb = !busy
        && !project.stopFailure
        && (status === 'not-responding'
          || (status === 'active' && project.httpUnresponsive));
      if (unresponsiveWeb) {
        return {
          action: 'output',
          disabled: false,
          label: `View output for ${name}`,
          mode: 'output'
        };
      }
      return { action: 'stop', disabled: busy, label: `Stop ${name}`, mode: 'stop' };
    }
    if (project.folderAccessible === false) {
      if (typeof project.composePath === 'string' && project.composePath.trim()) {
        return {
          action: 'edit',
          disabled: busy,
          label: `Edit ${name} to update its folder`,
          mode: 'review'
        };
      }
      return {
        action: 'relink-folder',
        disabled: busy,
        label: `Choose a new folder for ${name}`,
        mode: 'relink'
      };
    }
    if (status === 'stopped' && !busy && project.failureSummary && typeof project.failureSummary === 'object') {
      return {
        action: 'output',
        disabled: false,
        label: `View output for ${name}`,
        mode: 'output'
      };
    }
    return composeStartGate(project, {
      action: 'start',
      disabled: busy,
      label: `Start ${name}`,
      mode: 'start'
    });
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

  return {
    isMissingRequiredEnvFailure,
    projectCanRelinkFolder,
    projectHasLiveFolderStatus,
    projectPrimaryAction
  };
}));
