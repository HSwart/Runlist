const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectLifecycleCapability,
  projectLifecycleCapability
} = require('../lifecycle-capability');

test('supports native local lifecycle on macOS, Windows, and Linux', () => {
  const local = detectLifecycleCapability({});
  assert.equal(projectLifecycleCapability(local, { folder: '/Users/me/app' }, 'darwin').supported, true);
  assert.equal(projectLifecycleCapability(local, { folder: 'C:\\work\\app' }, 'win32').supported, true);
  assert.equal(projectLifecycleCapability(local, { folder: '/home/me/app' }, 'linux').supported, true);
});

test('blocks remote extension environments before probing local ports', () => {
  for (const remoteName of ['wsl', 'dev-container', 'ssh-remote', 'codespaces', 'tunnel']) {
    const capability = detectLifecycleCapability({ remoteName });
    assert.equal(capability.supported, false);
    assert.match(capability.reason, /local projects/);
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
