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
  if (remote === 'wsl' && kind === 'workspace') {
    return { activate: true, reason: 'wsl-workspace' };
  }
  if (remote === 'wsl' && kind === 'ui') {
    return { activate: false, reason: 'wsl-ui-defer' };
  }
  if (kind === 'workspace') {
    return { activate: false, reason: 'remote-workspace-skip' };
  }
  return { activate: true, reason: 'remote-ui-list-only' };
}

module.exports = {
  extensionKindName,
  resolveRunlistHostRole
};
