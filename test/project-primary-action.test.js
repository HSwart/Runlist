const assert = require('node:assert/strict');
const test = require('node:test');
const { projectCanRelinkFolder, projectPrimaryAction } = require('../media/project-actions');

test('turns detected external apps into a confirmed close-ports Stop action', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'active',
    stopCommand: ''
  }), {
    action: 'force-close-ports',
    disabled: false,
    label: 'Close processes using Attributes Finder ports',
    mode: 'stop'
  });
});

test('keeps Stop available through the confirmed port path when ownership is lost', () => {
  assert.equal(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'ownership-lost',
    stopCommand: ''
  }).action, 'force-close-ports');
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

test('turns a missing folder into Choose folder while Start stays off', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Moved app',
    status: 'stopped',
    folderAccessible: false
  }), {
    action: 'relink-folder',
    disabled: false,
    label: 'Choose a new folder for Moved app',
    mode: 'relink'
  });
  assert.equal(projectCanRelinkFolder({
    name: 'Moved app',
    status: 'stopped',
    folderAccessible: false
  }), true);
});

test('keeps Stop when a running project’s folder goes missing', () => {
  assert.equal(projectPrimaryAction({
    name: 'Moved app',
    status: 'running',
    folderAccessible: false
  }).action, 'stop');
  assert.equal(projectCanRelinkFolder({
    name: 'Moved app',
    status: 'running',
    folderAccessible: false
  }), false);
  assert.equal(projectPrimaryAction({
    name: 'Moved app',
    status: 'starting',
    folderAccessible: false
  }).action, 'stop');
  assert.equal(projectPrimaryAction({
    name: 'Moved app',
    status: 'stopping',
    folderAccessible: false
  }).action, 'stop');
});

test('does not offer Choose folder for Compose or review-required projects', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Compose app',
    status: 'stopped',
    folderAccessible: false,
    composePath: '/tmp/compose.yaml'
  }), {
    action: 'edit',
    disabled: false,
    label: 'Edit Compose app to update its folder',
    mode: 'review'
  });
  assert.equal(projectCanRelinkFolder({
    name: 'Compose app',
    status: 'stopped',
    folderAccessible: false,
    composePath: '/tmp/compose.yaml'
  }), false);
  assert.equal(projectPrimaryAction({
    name: 'Agent app',
    status: 'stopped',
    folderAccessible: false,
    reviewRequired: true
  }).action, 'edit');
  assert.equal(projectCanRelinkFolder({
    name: 'Agent app',
    status: 'stopped',
    folderAccessible: false,
    reviewRequired: true
  }), false);
});

test('still offers Choose folder when local lifecycle is unavailable', () => {
  assert.equal(projectPrimaryAction({
    name: 'Remote app',
    status: 'stopped',
    folderAccessible: false,
    lifecycleBlocked: true,
    lifecycleBlockedReason: 'Local projects only.'
  }).action, 'relink-folder');
});
