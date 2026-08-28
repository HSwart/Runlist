const assert = require('node:assert/strict');
const test = require('node:test');
const { projectCanRelinkFolder, projectPrimaryAction } = require('../media/project-actions');

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

test('turns unknown port conflicts into an inspect-first action', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'port-in-use-unknown',
    portConflict: { port: 7072 }
  }), {
    action: 'resolve-port-conflict',
    disabled: false,
    label: "See what's using port 7072 for Attributes Finder",
    mode: 'start',
    port: 7072
  });
});

test('does not force-close from the primary when the unknown conflict is busy', () => {
  assert.equal(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'port-in-use-unknown',
    forceClosing: true,
    portConflict: { port: 7072 }
  }).disabled, true);
  assert.equal(projectPrimaryAction({
    name: 'Attributes Finder',
    status: 'port-in-use-unknown',
    handoffInProgress: true,
    portConflict: { port: 7072 }
  }).action, 'resolve-port-conflict');
});

test('keeps compose start-gate labels for unknown port conflicts', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'Api',
    status: 'port-in-use-unknown',
    composeStartBlocked: true,
    composeStartBlockedReason: 'Docker is not ready',
    portConflict: { port: 3000 }
  }), {
    action: 'start',
    disabled: true,
    label: 'Docker is not ready',
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

test('turns a missing-required-env start failure into Fix environment', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'API',
    status: 'stopped',
    failureSummary: {
      title: 'Start failed',
      message: 'Missing required environment variables for this launch profile: API_KEY.',
      kind: 'missing-required-env'
    }
  }), {
    action: 'fix-environment',
    disabled: false,
    label: 'Fix environment setup for API',
    mode: 'review'
  });
});

test('turns a generic retained start failure into View output', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'App',
    status: 'stopped',
    failureSummary: { title: 'Start failed', message: 'command not found' }
  }), {
    action: 'output',
    disabled: false,
    label: 'View output for App',
    mode: 'output'
  });
});

test('keeps Start when a stopped row has no retained failure summary', () => {
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'stopped'
  }).action, 'start');
});

test('does not replace Choose folder when a missing-folder row also has a start failure', () => {
  assert.equal(projectPrimaryAction({
    name: 'Moved app',
    status: 'stopped',
    folderAccessible: false,
    failureSummary: { title: 'Start failed', message: 'command not found' }
  }).action, 'relink-folder');
});

test('does not replace Start while a generic failure is still force-closing', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'App',
    status: 'stopped',
    forceClosing: true,
    failureSummary: { title: 'Start failed', message: 'command not found' }
  }), {
    action: 'start',
    disabled: true,
    label: 'Start App',
    mode: 'start'
  });
});

test('review setup still gates missing-env rows', () => {
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'stopped',
    reviewRequired: true,
    failureSummary: { kind: 'missing-required-env' }
  }).action, 'edit');
});

test('turns a retained stop failure into View output while the process may still be running', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'App',
    status: 'running',
    stopFailure: 'Port :3000 is still up'
  }), {
    action: 'output',
    disabled: false,
    label: 'View output for App',
    mode: 'output'
  });
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'active',
    stopCommand: '',
    stopFailure: 'Port :3000 is still up'
  }).action, 'output');
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'not-responding',
    stopFailure: 'Stop failed'
  }).action, 'output');
});

test('keeps Stop when a running row has no stop failure', () => {
  assert.equal(projectPrimaryAction({ name: 'App', status: 'running' }).action, 'stop');
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'active',
    stopCommand: 'docker compose down'
  }).action, 'stop');
});

test('keeps disabled Stop while a stop-failure row is still stopping', () => {
  const action = projectPrimaryAction({
    name: 'App',
    status: 'stopping',
    stopFailure: 'Port :3000 is still up'
  });
  assert.equal(action.action, 'stop');
  assert.equal(action.disabled, true);
});

test('does not replace Stop with View output during force-close or handoff', () => {
  assert.deepEqual(projectPrimaryAction({
    name: 'App',
    status: 'running',
    forceClosing: true,
    stopFailure: 'Port :3000 is still up'
  }), {
    action: 'stop',
    disabled: true,
    label: 'Stop App',
    mode: 'stop'
  });
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'running',
    handoffInProgress: true,
    stopFailure: 'Stop failed'
  }).action, 'stop');
});

test('port-conflict and review primaries still beat a retained stop failure', () => {
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'port-in-use-unknown',
    stopFailure: 'Port :3000 is still up',
    portConflict: { port: 3000 }
  }).action, 'resolve-port-conflict');
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'port-in-use',
    stopFailure: 'Stop failed',
    portConflict: {
      port: 3000,
      ownerName: 'Other app',
      handoffAvailable: true
    }
  }).action, 'handoff');
  assert.equal(projectPrimaryAction({
    name: 'App',
    status: 'running',
    reviewRequired: true,
    stopFailure: 'Stop failed'
  }).action, 'edit');
});

test('preserves ordinary Start, Stop, custom Stop, review, and transition behavior', () => {
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopped' }).action, 'start');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'running' }).action, 'stop');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'active', stopCommand: 'docker compose down' }).action, 'stop');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopped', reviewRequired: true }).action, 'edit');
  assert.equal(projectPrimaryAction({ name: 'App', status: 'stopping' }).disabled, true);
  assert.equal(projectPrimaryAction({ name: 'App', status: 'active', forceClosing: true }).disabled, true);
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
