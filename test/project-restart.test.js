const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { restartProjectSafely } = require('../project-process');

test('exposes an accessible single-project Restart overflow action', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(script, /data-action="restart" data-id="\$\{projectId\}" role="menuitem" aria-label="Restart \$\{projectName\}"/);
  assert.match(script, /const detectedWithoutStop = projectStatus === 'active' && !project\.stopCommand/);
  assert.match(script, /\['running', 'not-ready', 'not-responding', 'ownership-lost', 'active'\]\.includes\(projectStatus\)[\s\S]*&& !detectedWithoutStop[\s\S]*&& !ownershipLostWithoutStop/);
  assert.match(script, /\$\{canRestart \? '' : 'disabled'\}/);
  assert.match(script, /data-action="restart"[\s\S]*\$\{icon\('refresh', 'menu-icon'\)\}<span>Restart<\/span>/);
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

test('reports Restart failure when the new Start is rejected', async () => {
  const calls = [];
  const result = await restartProjectSafely(new Set(), 'project-1', {
    stop: async () => { calls.push('stop'); return true; },
    waitForStop: async () => { calls.push('wait'); return true; },
    start: async () => { calls.push('start'); return false; }
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['stop', 'wait', 'start']);
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
  const refreshOwnership = source.indexOf('const latestProcessRuntime = this.processOwnership.snapshot()');
  const verifyPortOwnership = source.indexOf('hasUnownedPortReservation(id', refreshOwnership);
  const latestOwnership = source.indexOf('const latestSharedOwnership = latestProcessRuntime.get(id)', verifyPortOwnership);
  const reserveDeletion = source.indexOf('const deletionConflict = this.processOwnership.reserve(id)', refreshOwnership);
  const removeSavedProject = source.indexOf('removeProject(this.projectsFile, id)', reserveDeletion);
  const releaseDeletion = source.indexOf('this.processOwnership.release(id)', removeSavedProject);

  assert.ok(refreshOwnership >= 0);
  assert.ok(refreshOwnership < verifyPortOwnership);
  assert.ok(verifyPortOwnership < latestOwnership);
  assert.ok(latestOwnership < reserveDeletion);
  assert.ok(reserveDeletion < removeSavedProject);
  assert.ok(removeSavedProject < releaseDeletion);
  assert.match(source, /if \(hadTrackedProcess\)[\s\S]*cleanupTrackedProcessForDeletion[\s\S]*this\.processOwnership\.release\(id\)/);
});

test('prevents service metadata changes while a project is running', () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(extensionSource, /servicesLocked && servicesChanged/);
  assert.match(extensionSource, /if \(servicesChanged\)[\s\S]*this\.processOwnership\.reserve\(projectId\)/);
  assert.match(extensionSource, /if \(servicesReservation\)[\s\S]*this\.processOwnership\.release\(projectId\)/);
  assert.match(extensionSource, /servicesLocked: this\.mode === 'edit'[\s\S]*'running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'stopping', 'active'/);
  assert.match(webviewSource, /<fieldset id="services"[^>]*\$\{state\.servicesLocked \? 'disabled' : ''\}/);
  assert.match(webviewSource, /Stop this project before changing its services\./);
  assert.match(webviewSource, /project\.openPorts\?\.includes\(service\.port\)/);
});

test('re-reads the saved project after Start acquires process ownership', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const startProject = source.indexOf('async startProject(id, options = {})');
  const reserveOwnership = source.indexOf('this.processOwnership.reserve(id)', startProject);
  const rereadProjects = source.indexOf('projects = this.projects', reserveOwnership);
  const reservePorts = source.indexOf('this.portReservations.reserve(project)', rereadProjects);

  assert.ok(startProject >= 0);
  assert.ok(startProject < reserveOwnership);
  assert.ok(reserveOwnership < rereadProjects);
  assert.ok(rereadProjects < reservePorts);
});

test('falls back from a custom stop to port recovery or exact owned-process cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const stopProject = source.indexOf('async stopProject(id, projectSnapshot, options = {})');
  const customStop = source.indexOf('if (stopProject.stopCommand)', stopProject);
  const chooseFallback = source.indexOf('customStopFallbackAction({', customStop);
  const recoverPorts = source.indexOf("this.forceCloseProjectPorts(id, 'stop')", chooseFallback);
  const recoverOwnedProcess = source.indexOf('this.stopOwnedProjectProcess(id, stopProject, {', recoverPorts);
  const defaultStop = source.indexOf('return this.stopOwnedProjectProcess(id, stopProject, options);', recoverOwnedProcess);

  assert.ok(stopProject >= 0);
  assert.ok(customStop >= 0);
  assert.ok(customStop < chooseFallback);
  assert.ok(chooseFallback < recoverPorts);
  assert.ok(recoverPorts < recoverOwnedProcess);
  assert.ok(recoverOwnedProcess < defaultStop);
});

test('routes remote custom stops through the launching VS Code window', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const consumeRequests = source.indexOf('this.processOwnership.consumeStopRequests()');
  const dispatchToOwner = source.indexOf('void Promise.resolve(this.stopProject(id, project', consumeRequests);
  const completeRequest = source.indexOf('this.processOwnership.completeStopRequest(id)', dispatchToOwner);
  const stopProject = source.indexOf('async stopProject(id, projectSnapshot, options = {})');
  const sharedOwnership = source.indexOf('const sharedOwnership = this.processOwnership.snapshot().get(id)', stopProject);
  const requestRemoteStop = source.indexOf('return this.stopOwnedProjectProcess(id, stopProject, options);', sharedOwnership);
  const runCustomStop = source.indexOf('const customStopResult = await this.runCustomStopCommand(stopProject)', sharedOwnership);

  assert.ok(consumeRequests >= 0);
  assert.ok(consumeRequests < dispatchToOwner);
  assert.ok(dispatchToOwner < completeRequest);
  assert.ok(stopProject < sharedOwnership);
  assert.ok(sharedOwnership < requestRemoteStop);
  assert.ok(requestRemoteStop < runCustomStop);
});

test('recovers a locally owned process when its in-memory handle is missing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const localRequest = source.indexOf("if (request.kind === 'local')");
  const recoverOwnedProcess = source.indexOf('this.processOwnership.terminateOwnedProcess(id)', localRequest);
  const finishRecoveredStop = source.indexOf('this.finishStopping(id, true)', recoverOwnedProcess);

  assert.ok(localRequest >= 0);
  assert.ok(localRequest < recoverOwnedProcess);
  assert.ok(recoverOwnedProcess < finishRecoveredStop);
});

test('does not report an intentional custom-stop exit as a start failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /const stoppedIntentionally = this\.stoppingProjectIds\.has\(id\)/);
  assert.match(source, /const startFailed = startExitFailed\(\{ code, hasServices, stoppedIntentionally \}\);[\s\S]*if \(startFailed\) \{[\s\S]*this\.showStartFailure\(/);
});

test('allows remote custom stops enough time for owner polling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /const STATUS_POLL_INTERVAL_MS = 2000;/);
  assert.match(source, /const CUSTOM_STOP_TIMEOUT_MS = 15000;/);
  assert.match(source, /const CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS = 20000;/);
  assert.match(source, /const REMOTE_STOP_TIMEOUT_MS = STATUS_POLL_INTERVAL_MS[\s\S]*\+ CUSTOM_STOP_TIMEOUT_MS[\s\S]*\+ CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS[\s\S]*\+ 1000;/);
  assert.match(source, /setInterval\(\(\) => this\.refreshProjectStatuses\(\), STATUS_POLL_INTERVAL_MS\)/);
  assert.match(source, /waitForProjectStopCompletion\(id, CUSTOM_STOP_SHUTDOWN_TIMEOUT_MS\)/);
});
