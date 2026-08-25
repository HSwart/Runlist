const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectLifecycleCapability,
  projectLifecycleCapability
} = require('../src/lifecycle/lifecycle-capability');

test('supports native local lifecycle on macOS, Windows, and Linux', () => {
  const local = detectLifecycleCapability({});
  assert.equal(projectLifecycleCapability(local, { folder: '/Users/me/app' }, 'darwin').supported, true);
  assert.equal(projectLifecycleCapability(local, { folder: 'C:\\work\\app' }, 'win32').supported, true);
  assert.equal(projectLifecycleCapability(local, { folder: '/home/me/app' }, 'linux').supported, true);
});

test('blocks remote extension environments before probing local ports', () => {
  for (const remoteName of ['wsl', 'dev-container', 'ssh-remote', 'codespaces', 'tunnel']) {
    const capability = detectLifecycleCapability({ remoteName, extensionKind: 'ui' });
    assert.equal(capability.supported, false);
    assert.match(capability.reason, /local projects|WSL window/);
  }
});

test('supports Remote WSL lifecycle only in the Linux workspace host', () => {
  const workspace = detectLifecycleCapability({
    remoteName: 'wsl',
    platform: 'linux',
    extensionKind: 'workspace'
  });
  assert.equal(workspace.supported, true);
  assert.equal(workspace.kind, 'wsl-workspace');
  assert.equal(projectLifecycleCapability(workspace, { folder: '/home/me/app' }, 'linux').supported, true);

  const ui = detectLifecycleCapability({
    remoteName: 'wsl',
    platform: 'win32',
    extensionKind: 'ui'
  });
  assert.equal(ui.supported, false);

  const winWorkspace = detectLifecycleCapability({
    remoteName: 'wsl',
    platform: 'win32',
    extensionKind: 'workspace'
  });
  assert.equal(winWorkspace.supported, false);

  for (const remoteName of ['ssh-remote', 'dev-container', 'codespaces', 'tunnel']) {
    const remoteWorkspace = detectLifecycleCapability({
      remoteName,
      platform: 'linux',
      extensionKind: 'workspace'
    });
    assert.equal(remoteWorkspace.supported, false);
  }
});

test('blocks Windows WSL network paths while allowing native UNC paths', () => {
  const local = detectLifecycleCapability({});
  assert.equal(projectLifecycleCapability(local, {
    folder: '\\\\wsl$\\Ubuntu\\home\\me\\app'
  }, 'win32').supported, false);
  assert.equal(projectLifecycleCapability(local, {
    folder: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'
  }, 'win32').supported, false);
  assert.equal(projectLifecycleCapability(local, {
    folder: '\\\\server\\share\\app'
  }, 'win32').supported, true);
});

test('blocks unverified local platforms', () => {
  const capability = detectLifecycleCapability({ platform: 'aix' });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /cannot verify/);
});
