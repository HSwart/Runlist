const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveRunlistHostRole } = require('../src/host/runlist-host-role');

test('activates the local host and the WSL workspace host', () => {
  assert.deepEqual(resolveRunlistHostRole({}), { activate: true, reason: 'local' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'wsl',
    extensionKind: 2
  }), { activate: true, reason: 'wsl-workspace' });
});

test('activates a WSL UI fallback instead of leaving commands unregistered', () => {
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'wsl',
    extensionKind: 'ui'
  }), { activate: true, reason: 'wsl-ui-list-only' });
});

test('activates SSH and other remotes on the host VS Code selected', () => {
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'ssh-remote',
    extensionKind: 'ui'
  }), { activate: true, reason: 'remote-ui-list-only' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'ssh-remote',
    extensionKind: 'workspace'
  }), { activate: true, reason: 'remote-workspace-list-only' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'dev-container',
    extensionKind: 'workspace'
  }), { activate: true, reason: 'remote-workspace-list-only' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'codespaces',
    extensionKind: 'workspace'
  }), { activate: true, reason: 'remote-workspace-list-only' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'tunnel',
    extensionKind: 'workspace'
  }), { activate: true, reason: 'remote-workspace-list-only' });
});
