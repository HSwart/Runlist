const assert = require('node:assert/strict');
const test = require('node:test');
const { detectRuntimeDrift } = require('../src/projects/runtime-drift');

test('detects Python version drift between PATH and project venv', () => {
  const drift = detectRuntimeDrift({
    runtime: 'azure-functions-python',
    folder: 'C:\\repo\\func'
  }, {
    existsSync: (candidate) => String(candidate).includes('.venv'),
    pathSep: '\\',
    spawnSync: (command) => {
      if (String(command).includes('.venv')) {
        return { status: 0, stdout: 'Python 3.13.2\n', stderr: '' };
      }
      return { status: 0, stdout: 'Python 3.12.8\n', stderr: '' };
    }
  });

  assert.equal(drift.kind, 'python-version-mismatch');
  assert.match(drift.message, /3\.13\.2/);
  assert.match(drift.message, /3\.12\.8/);
  assert.doesNotMatch(drift.message, /secret|password/i);
});

test('skips drift checks for Node runtimes', () => {
  assert.equal(detectRuntimeDrift({
    runtime: 'node',
    folder: '/repo'
  }, {
    existsSync: () => true
  }), undefined);
});
