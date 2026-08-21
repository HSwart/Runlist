function detectLifecycleCapability({ remoteName, platform = process.platform } = {}) {
  const remote = String(remoteName || '').trim();
  if (!remote) {
    if (!['darwin', 'linux', 'win32'].includes(platform)) {
      return {
        supported: false,
        kind: 'unsupported-platform',
        reason: `Lifecycle controls are unavailable on ${platform || 'this platform'} because Runlist cannot verify its process and port behavior.`
      };
    }
    return { supported: true, kind: 'local' };
  }

  const labels = {
    codespaces: 'GitHub Codespaces',
    'dev-container': 'a Dev Container',
    'ssh-remote': 'a remote SSH host',
    tunnel: 'a VS Code Tunnel',
    wsl: 'WSL'
  };
  const label = labels[remote] || `the ${remote} remote environment`;
  return {
    supported: false,
    kind: remote,
    reason: `Lifecycle controls are unavailable because this VS Code window is connected to ${label}. Runlist can only verify processes and ports for local projects in this release.`
  };
}

function projectLifecycleCapability(baseCapability, project, platform = process.platform) {
  if (baseCapability?.supported === false) {
    return baseCapability;
  }
  const folder = String(project?.folder || '');
  if (platform === 'win32' && /^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(folder)) {
    return {
      supported: false,
      kind: 'wsl-path',
      reason: 'Lifecycle controls are unavailable for WSL network paths because Windows process ownership and ports do not identify the processes inside WSL.'
    };
  }
  return { supported: true, kind: 'local' };
}

module.exports = { detectLifecycleCapability, projectLifecycleCapability };
