const assert = require('node:assert/strict');
const test = require('node:test');
const { projectPrimaryAction } = require('../media/project-actions');

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

test('preserves ordinary Start, Stop, custom Stop, review, and transition behavior', () => {
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopped' }).action, 'start');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'running' }).action, 'stop');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'active', stopCommand: 'docker compose down' }).action, 'stop');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopped', reviewRequired: true }).action, 'edit');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopping' }).disabled, true);
  assert.equal(projectPrimaryAction({ name: 'App', status: 'active', forceClosing: true }).disabled, true);
});
