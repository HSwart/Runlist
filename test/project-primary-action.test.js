const assert = require('node:assert/strict');
const test = require('node:test');
const { projectPrimaryAction } = require('../media/project-actions');

test('turns detected apps without a stop command into Add stop command', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'active',
    stopCommand: ''
  }), {
    action: 'add-stop-command',
    disabled: false,
    label: 'Add a stop command for Attributes Finder',
    mode: 'edit'
  });
});

test('offers Add stop command when ownership is lost and no stop command is saved', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'ownership-lost',
    stopCommand: ''
  }), {
    action: 'add-stop-command',
    disabled: false,
    label: 'Add a stop command for Attributes Finder',
    mode: 'edit'
  });
});

test('still lets Add stop command open Edit when lifecycle controls are blocked', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Remote app',
    status: 'active',
    stopCommand: '',
    lifecycleBlocked: true,
    lifecycleBlockedReason: 'Local projects only.'
  }), {
    action: 'add-stop-command',
    disabled: false,
    label: 'Add a stop command for Remote app',
    mode: 'edit'
  });
});

test('turns unknown port conflicts into a confirmed close-and-start action', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'port-in-use-unknown',
    portConflict: { port: 7072 }
  }), {
    action: 'force-close-ports-and-start',
    disabled: false,
    label: 'Close processes using port 7072 and start Attributes Finder',
    mode: 'start'
  });
});

test('uses the existing safe handoff when another live Runlist project owns the conflict', () => {
  const project = {
    name: 'Attributes Finder',
    status: 'port-in-use',
    portConflict: {
      port: 7072,
      ownerName: 'Other app',
      handoffAvailable: true
    }
  };
  assert.equal(projectPrimaryAction(project).action, 'handoff');
  assert.equal(projectPrimaryAction({ ...project, handoffInProgress: true }).disabled, true);
});

test('does not force-close a mixed or multi-project managed conflict', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'port-in-use',
    portConflict: {
      kind: 'managed',
      ownerName: 'Other app',
      handoffAvailable: false
    }
  }), {
    action: 'start',
    disabled: true,
    label: 'Stop Other app and any other Runlist port owners before starting Attributes Finder',
    mode: 'start'
  });
});

test('preserves ordinary Start, Stop, custom Stop, review, and transition behavior', () => {
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopped' }).action, 'start');
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'stopped',
    failureSummary: { title: 'Start failed', message: 'command not found' }
  }).action, 'start');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'running' }).action, 'stop');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'active', stopCommand: 'docker compose down' }).action, 'stop');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopped', reviewRequired: true }).action, 'edit');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopping' }).disabled, true);
  assert.equal(projectPrimaryAction({ name: 'App', status: 'active', forceClosing: true }).disabled, true);
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'running',
    stopFailure: 'Stop failed'
  }).action, 'stop');
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'active',
    stopCommand: '',
    stopFailure: 'Port :3000 is still up'
  }).action, 'stop');
});

test('disables lifecycle actions when the project environment cannot be verified', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Remote app',
    status: 'unsupported',
    lifecycleBlocked: true,
    lifecycleBlockedReason: 'Local projects only.'
  }), {
    action: 'start',
    disabled: true,
    label: 'Local projects only.',
    mode: 'start'
  });
});
