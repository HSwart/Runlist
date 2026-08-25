const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveRunlistHostRole } = require('../src/host/runlist-host-role');

test('activates the local UI host and defers the Windows WSL UI host', () => {
  assert.deepEqual(resolveRunlistHostRole({}), { activate: true, reason: 'local' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'wsl',
    extensionKind: 'ui'
  }), { activate: false, reason: 'wsl-ui-defer' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'wsl',
    extensionKind: 2
  }), { activate: true, reason: 'wsl-workspace' });
});

test('keeps SSH and other remotes as UI list-only hosts', () => {
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'ssh-remote',
    extensionKind: 'ui'
  }), { activate: true, reason: 'remote-ui-list-only' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'ssh-remote',
    extensionKind: 'workspace'
  }), { activate: false, reason: 'remote-workspace-skip' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'dev-container',
    extensionKind: 'workspace'
  }), { activate: false, reason: 'remote-workspace-skip' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'codespaces',
    extensionKind: 'workspace'
  }), { activate: false, reason: 'remote-workspace-skip' });
  assert.deepEqual(resolveRunlistHostRole({
    remoteName: 'tunnel',
    extensionKind: 'workspace'
  }), { activate: false, reason: 'remote-workspace-skip' });
});
