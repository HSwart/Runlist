function extensionKindName(extensionKind) {
  if (extensionKind === 2 || extensionKind === 'workspace') {
    return 'workspace';
  }
  return 'ui';
}

function resolveRunlistHostRole({ remoteName, extensionKind } = {}) {
  const remote = String(remoteName || '').trim();
  const kind = extensionKindName(extensionKind);
  if (!remote) {
    return { activate: true, reason: 'local' };
  }
  // VS Code picks one host from extensionKind. The selected host must activate;
  // skipping it leaves commands and the sidebar unregistered.
  if (remote === 'wsl' && kind === 'workspace') {
    return { activate: true, reason: 'wsl-workspace' };
  }
  if (remote === 'wsl' && kind === 'ui') {
    return { activate: true, reason: 'wsl-ui-list-only' };
  }
  if (kind === 'workspace') {
    return { activate: true, reason: 'remote-workspace-list-only' };
  }
  return { activate: true, reason: 'remote-ui-list-only' };
}

module.exports = {
  extensionKindName,
  resolveRunlistHostRole
};
