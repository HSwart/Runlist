const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { restartProjectSafely } = require('../project-process');

test('exposes an accessible single-project Restart overflow action', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(script, /data-action="restart" data-id="\$\{projectId\}" role="menuitem" aria-label="Restart \$\{projectName\}"/);
  assert.match(script, /const detectedWithoutStop = projectStatus === 'active' && !project\.stopCommand/);
  assert.match(script, /\['running', 'not-ready', 'active'\]\.includes\(projectStatus\)[\s\S]*&& !detectedWithoutStop/);
  assert.match(script, /\$\{canRestart \? '' : 'disabled'\}/);
  assert.match(script, /restart: \(\) => vscode\.postMessage\(\{ type: 'restartProject', id: button\.dataset\.id \}\)/);
});

test('waits for a safe Stop to complete before starting again', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => {
      calls.push('stop');
      return true;
    },
    waitForStop: async () => {
      calls.push('wait');
      return true;
    },
    start: async () => {
      calls.push('start');
    }
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ['stop', 'wait', 'start']);
});

test('does not Start when Stop fails', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => {
      calls.push('stop');
      return false;
    },
    waitForStop: async () => {
      calls.push('wait');
      return true;
    },
    start: async () => {
      calls.push('start');
    }
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['stop']);
});

test('does not Start when remote Stop completion cannot be confirmed', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => {
      calls.push('stop');
      return true;
    },
    waitForStop: async () => {
      calls.push('wait');
      return false;
    },
    start: async () => {
      calls.push('start');
    }
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['stop', 'wait']);
});

test('ignores duplicate Restart requests while one is active', async () => {
  const restarting = new Set();
  let releaseStop;
  let starts = 0;
  const actions = {
    stop: () => new Promise((resolve) => {
      releaseStop = resolve;
    }),
    waitForStop: async () => true,
    start: async () => {
      starts += 1;
    }
  };

  const first = restartProjectSafely(restarting, 'project-1', actions);
  assert.equal(await restartProjectSafely(restarting, 'project-1', actions), false);
  releaseStop(true);
  assert.equal(await first, true);
  assert.equal(starts, 1);
  assert.equal(restarting.has('project-1'), false);
});

test('ignores a stale Restart request while a shared transition is active', async () => {
  let stops = 0;
  const result = await restartProjectSafely(new Set(), 'project-1', {
    canRestart: () => false,
    stop: async () => {
      stops += 1;
      return true;
    },
    waitForStop: async () => true,
    start: async () => {}
  });

  assert.equal(result, false);
  assert.equal(stops, 0);
});

test('holds process ownership while deleting a saved project', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const refreshOwnership = source.indexOf('const latestSharedOwnership = this.processOwnership.snapshot().get(id)');
  const reserveDeletion = source.indexOf('const deletionConflict = this.processOwnership.reserve(id)', refreshOwnership);
  const removeSavedProject = source.indexOf('removeProject(this.projectsFile, id)', reserveDeletion);
  const releaseDeletion = source.indexOf('this.processOwnership.release(id)', removeSavedProject);

  assert.ok(refreshOwnership >= 0);
  assert.ok(refreshOwnership < reserveDeletion);
  assert.ok(reserveDeletion < removeSavedProject);
  assert.ok(removeSavedProject < releaseDeletion);
});

test('prevents service metadata changes while a project is running', () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(extensionSource, /servicesLocked && projectServicesChanged\(validation\.values, existingProject\)/);
  assert.match(extensionSource, /servicesLocked: this\.mode === 'edit'[\s\S]*'running', 'starting', 'not-ready', 'stopping', 'active'/);
  assert.match(webviewSource, /<fieldset id="services"[^>]*\$\{state\.servicesLocked \? 'disabled' : ''\}/);
  assert.match(webviewSource, /Stop this project before changing its services\./);
});
