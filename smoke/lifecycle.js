const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');
const { readRootProcess } = require('../src/lifecycle/process-metrics');
const {
  cleanupSmokeProcess,
  markSmokeProcessExited,
  registerSmokeProcess
} = require('./run');

async function run() {
  const smokeRoot = requiredEnvironment('RUNLIST_SMOKE_ROOT');
  const nodePath = requiredEnvironment('RUNLIST_SMOKE_NODE');
  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  assert.ok(extension, 'The Runlist development extension was not installed.');
  const api = await extension.activate();
  assert.ok(api?.provider, 'The extension did not expose its guarded smoke API.');
  assertInside(api.projectsFile, smokeRoot, 'Reloaded Runlist storage escaped the isolated smoke profile.');

  const ready = api.provider.projects.find((project) => project.name === 'Ready smoke project');
  const customStop = api.provider.projects.find((project) => project.name === 'Custom stop smoke project');
  const delayed = api.provider.projects.find((project) => project.name === 'Delayed smoke project');
  const externalConflict = api.provider.projects.find((project) => project.name === 'External conflict smoke project');
  const handoffSource = api.provider.projects.find((project) => project.name === 'Handoff source smoke project');
  const handoffTarget = api.provider.projects.find((project) => project.name === 'Handoff target smoke project');
  const failure = api.provider.projects.find((project) => project.name === 'Failure smoke project');
  const temporaryPort = api.provider.projects.find((project) => project.name === 'Temporary port smoke project');
  const manual = api.provider.projects.find((project) => project.name === 'Manual smoke project');
  assert.ok(
    ready && customStop && delayed && externalConflict && handoffSource && handoffTarget
      && failure && temporaryPort && manual,
    'Saved projects did not reload in the second extension host.'
  );
  assert.equal(api.provider.projects.length, 10, 'The second extension host loaded incomplete saved state.');

  const fixturePidPath = path.join(smokeRoot, 'ready.pid');
  const childPidPath = path.join(smokeRoot, 'ready-child.pid');
  const grandchildPidPath = path.join(smokeRoot, 'ready-grandchild.pid');
  assert.equal(fs.existsSync(fixturePidPath), true, 'The first extension host did not leave reload fixture evidence.');
  const preReloadPid = Number(fs.readFileSync(fixturePidPath, 'utf8'));
  const preReloadChildPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  const preReloadGrandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'));
  const customStopPid = Number(fs.readFileSync(path.join(smokeRoot, 'custom-stop.pid'), 'utf8'));
  const fixtureProcesses = JSON.parse(fs.readFileSync(
    path.join(smokeRoot, 'fixture-identities.json'),
    'utf8'
  ));
  const preReloadProcesses = [preReloadPid, preReloadChildPid, preReloadGrandchildPid]
    .map((pid) => fixtureProcess(fixtureProcesses, pid));
  const customStopProcess = fixtureProcess(fixtureProcesses, customStopPid);
  assert.equal(
    (await Promise.all(preReloadProcesses.map(exactProcessIsAlive))).every((alive) => !alive),
    true,
    `Closing the first extension host left part of its owned process tree running: ${JSON.stringify({
      ownership: api.provider.processOwnership.snapshot().get(ready.id),
      reservation: api.provider.portReservations.snapshot().get(ready.id)
    })}`
  );
  assert.equal(
    await exactProcessIsAlive(customStopProcess),
    false,
    'Reload shutdown left the custom Stop fixture running.'
  );
  assert.equal(
    fs.existsSync(path.join(smokeRoot, 'custom-stop.used')),
    true,
    'Reload shutdown bypassed the explicit custom stop command.'
  );
  await waitFor(
    async () => {
      await api.provider.refreshProjectStatuses();
      return lifecycleIsStopped(api.provider, ready.id);
    },
    () => `The reloaded extension host did not observe a fully stopped lifecycle: ${JSON.stringify(
      lifecycleEvidence(api.provider, ready.id)
    )}`
  );
  fs.rmSync(fixturePidPath, { force: true });
  fs.rmSync(childPidPath, { force: true });
  fs.rmSync(grandchildPidPath, { force: true });

  let unrelated;
  let unrelatedProcessRecord;
  let orphanRecovery;
  let orphanRecoveryProcessRecord;
  let delayedPid;
  let externalListener;
  let externalListenerProcessRecord;
  let temporaryPortBlocker;
  let temporaryPortBlockerRecord;
  let handoffTargetPid;

  try {
    unrelated = spawn(nodePath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    unrelatedProcessRecord = await registerSmokeProcess(smokeRoot, unrelated, {
      kind: 'lifecycle-sentinel',
      name: 'Unrelated smoke sentinel',
      terminateTree: false
    });
    fs.writeFileSync(path.join(smokeRoot, 'unrelated.pid'), String(unrelated.pid));

    assert.equal(await api.provider.startProject(ready.id), true, 'Runlist did not start the ready fixture.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return lifecycleIsRunning(api.provider, ready.id);
      },
      () => `Ready fixture never reached a coordinated running state: ${JSON.stringify(
        lifecycleEvidence(api.provider, ready.id)
      )}`,
      20000
    );

    const initialOwnershipToken = api.provider.processOwnership.snapshot().get(ready.id)?.token;
    const initialPortGeneration = api.provider.portReservations.captureShared(ready.id);
    assert.equal(typeof initialOwnershipToken, 'string', 'Start did not create an ownership generation.');
    assert.equal(initialPortGeneration.size, 1, 'Start did not create the configured port generation.');

    await waitFor(() => fs.existsSync(fixturePidPath), 'The ready fixture did not report its process id.');
    const fixturePid = Number(fs.readFileSync(fixturePidPath, 'utf8'));
    await waitFor(
      () => fs.existsSync(childPidPath) && fs.existsSync(grandchildPidPath),
      'The ready fixture did not report its descendant process ids.'
    );
    const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
    const grandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'));
    assert.equal(processIsAlive(fixturePid), true, 'The ready fixture exited before Stop was tested.');
    assert.equal(processIsAlive(childPid), true, 'The ready fixture child exited before Stop was tested.');
    assert.equal(processIsAlive(grandchildPid), true, 'The ready fixture grandchild exited before Stop was tested.');
    assert.equal(processIsAlive(unrelated.pid), true, 'The unrelated sentinel exited before Stop was tested.');

    fs.rmSync(fixturePidPath, { force: true });
    fs.rmSync(childPidPath, { force: true });
    fs.rmSync(grandchildPidPath, { force: true });

    const restarted = await api.provider.restartProject(ready.id);
    assert.equal(restarted, true, `Runlist did not restart its ready fixture: ${JSON.stringify({
      status: api.provider.getProjectStatus(ready.id),
      ownership: api.provider.processOwnership.snapshot().get(ready.id),
      reservation: api.provider.portReservations.snapshot().get(ready.id),
      conflict: api.provider.projectPortConflicts.get(ready.id),
      output: api.provider.projectOutputs.get(ready.id)
    })}`);
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return lifecycleIsRunning(api.provider, ready.id)
          && fs.existsSync(fixturePidPath)
          && fs.existsSync(childPidPath)
          && fs.existsSync(grandchildPidPath);
      },
      'The restarted fixture never became ready.',
      20000
    );
    const restartedPid = Number(fs.readFileSync(fixturePidPath, 'utf8'));
    const restartedChildPid = Number(fs.readFileSync(childPidPath, 'utf8'));
    const restartedGrandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'));
    const restartedOwnershipToken = api.provider.processOwnership.snapshot().get(ready.id)?.token;
    const restartedPortGeneration = api.provider.portReservations.captureShared(ready.id);
    assert.equal(typeof restartedOwnershipToken, 'string', 'Restart did not create an ownership generation.');
    assert.notEqual(
      restartedOwnershipToken,
      initialOwnershipToken,
      'Restart retained the previous ownership generation.'
    );
    assert.equal(restartedPortGeneration.size, 1, 'Restart did not create a complete port generation.');
    assert.notDeepEqual(
      [...restartedPortGeneration],
      [...initialPortGeneration],
      'Restart retained the previous port reservation generation.'
    );
    assert.notEqual(restartedPid, fixturePid, 'Restart reused the previous fixture process.');
    assert.notEqual(restartedChildPid, childPid, 'Restart reused the previous fixture child process.');
    assert.notEqual(restartedGrandchildPid, grandchildPid, 'Restart reused the previous fixture grandchild process.');
    await waitFor(
      () => [fixturePid, childPid, grandchildPid].every((pid) => !processIsAlive(pid)),
      'Restart left part of the previous fixture process tree running.',
      process.platform === 'win32' ? 20000 : 10000
    );

    api.provider.projectStatuses.set(ready.id, 'stopping');
    api.provider.stoppingProjectIds.delete(ready.id);
    assert.equal(await api.provider.stopProject(ready.id), true, 'Runlist did not stop its restarted fixture.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return [restartedPid, restartedChildPid, restartedGrandchildPid]
          .every((pid) => !processIsAlive(pid))
          && lifecycleIsStopped(api.provider, ready.id);
      },
      () => `Stop did not clear the complete owned lifecycle: ${JSON.stringify(
        lifecycleEvidence(api.provider, ready.id)
      )}`
    );
    assert.equal(processIsAlive(unrelated.pid), true, 'Lifecycle actions terminated an unrelated process.');

    assert.equal(await api.provider.startProject(delayed.id), true, 'Runlist did not start the delayed fixture.');
    assert.equal(
      api.provider.getProjectStatus(delayed.id),
      'starting',
      'The delayed fixture skipped its observable starting state.'
    );
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return api.provider.getProjectStatus(delayed.id) === 'running';
      },
      'The delayed fixture did not become ready after its delay.',
      10000
    );
    const delayedPidPath = path.join(smokeRoot, 'delayed.pid');
    assert.equal(fs.existsSync(delayedPidPath), true, 'The delayed fixture did not report its process id.');
    delayedPid = Number(fs.readFileSync(delayedPidPath, 'utf8'));
    assert.equal(await api.provider.stopProject(delayed.id), true, 'Runlist did not stop the delayed fixture.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return !processIsAlive(delayedPid) && lifecycleIsStopped(api.provider, delayed.id);
      },
      () => `Stop left delayed lifecycle evidence behind: ${JSON.stringify(
        lifecycleEvidence(api.provider, delayed.id)
      )}`
    );

    const fixturePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'ready.js');
    const externalPidPath = path.join(smokeRoot, 'external-listener.pid');
    externalListener = spawn(nodePath, [
      fixturePath,
      smokeRoot,
      String(externalConflict.services[0].port),
      '',
      '',
      '0',
      externalPidPath
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
    externalListenerProcessRecord = await registerSmokeProcess(smokeRoot, externalListener, {
      kind: 'external-listener',
      name: 'External conflict listener',
      ports: [Number(externalConflict.services[0].port)],
      terminateTree: false
    });
    await waitFor(() => fs.existsSync(externalPidPath), 'The external port listener did not become ready.');
    await api.provider.refreshProjectStatuses();
    assert.equal(
      api.provider.getProjectStatus(externalConflict.id),
      'active',
      'An external listener was not shown as detected running.'
    );
    assert.equal(
      await api.provider.startProject(externalConflict.id),
      false,
      'Runlist started a project on an externally occupied port.'
    );
    assert.equal(
      await api.provider.stopProject(externalConflict.id),
      false,
      'Runlist offered to stop an external port listener without a custom command.'
    );
    assert.equal(processIsAlive(externalListener.pid), true, 'Runlist terminated the external port listener.');
    assert.equal(
      lifecycleHasCoordination(api.provider, externalConflict.id),
      false,
      `Blocked external Start retained Runlist coordination: ${JSON.stringify(
        lifecycleEvidence(api.provider, externalConflict.id)
      )}`
    );
    assert.equal(
      fs.existsSync(path.join(smokeRoot, 'external-conflict-started.pid')),
      false,
      'The blocked external-conflict start command still executed.'
    );
    await cleanupSmokeProcess(
      smokeRoot,
      externalListener,
      externalListenerProcessRecord,
      'The external listener did not exit.'
    );
    await waitFor(
      () => !processIsAlive(externalListener.pid),
      'The external listener did not exit.'
    );
    await waitFor(
      async () => !(await exactProcessIsAlive(externalListenerProcessRecord)),
      'The external listener identity did not exit.'
    );
    await markSmokeProcessExited(smokeRoot, externalListenerProcessRecord);
    externalListener = undefined;
    externalListenerProcessRecord = undefined;
    await api.provider.refreshProjectStatuses();

    const temporarySavedPort = temporaryPort.services[0].port;
    const temporaryLaunchPort = Number(fs.readFileSync(
      path.join(smokeRoot, 'temporary-launch-port'),
      'utf8'
    ));
    const temporaryBlockerPidPath = path.join(smokeRoot, 'temporary-blocker.pid');
    temporaryPortBlocker = spawn(nodePath, [
      fixturePath,
      smokeRoot,
      String(temporarySavedPort),
      '',
      '',
      '0',
      temporaryBlockerPidPath
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
    temporaryPortBlockerRecord = await registerSmokeProcess(smokeRoot, temporaryPortBlocker, {
      kind: 'temporary-port-blocker',
      name: 'Temporary port smoke blocker',
      ports: [temporarySavedPort],
      terminateTree: false
    });
    await waitFor(
      () => fs.existsSync(temporaryBlockerPidPath),
      'The temporary-port blocker did not become ready.'
    );
    await api.provider.refreshProjectStatuses();
    assert.equal(
      api.provider.getProjectStatus(temporaryPort.id),
      'active',
      'The saved temporary-port service did not detect its external blocker.'
    );
    assert.equal(await api.provider.startProject(temporaryPort.id, {
      allowPortConflict: true,
      portOverrides: [{
        serviceName: temporaryPort.services[0].name,
        savedPort: temporarySavedPort,
        port: temporaryLaunchPort,
        variable: temporaryPort.services[0].portVariable
      }]
    }), true, 'Runlist did not start the project on its selected temporary port.');
    const temporaryProjectPidPath = path.join(smokeRoot, 'temporary-project.pid');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return lifecycleIsRunning(api.provider, temporaryPort.id)
          && fs.existsSync(temporaryProjectPidPath);
      },
      () => `The temporary-port launch did not become ready: ${JSON.stringify(
        lifecycleEvidence(api.provider, temporaryPort.id)
      )}`,
      10000
    );
    const temporaryProjectPid = Number(fs.readFileSync(temporaryProjectPidPath, 'utf8'));
    const temporaryGeneration = api.provider.portReservations.captureShared(temporaryPort.id);
    assert.deepEqual(
      [...temporaryGeneration.keys()],
      [temporaryLaunchPort],
      'The temporary launch reserved a port other than its effective launch port.'
    );
    assert.equal(
      api.provider.projects.find((project) => project.id === temporaryPort.id)?.services[0].port,
      temporarySavedPort,
      'The temporary launch edited the saved service port.'
    );
    assert.equal(
      processIsAlive(temporaryPortBlocker.pid),
      true,
      'Starting on a temporary port terminated the saved-port blocker.'
    );
    assert.equal(
      await api.provider.stopProject(temporaryPort.id),
      true,
      'Runlist did not stop the temporary-port launch.'
    );
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return !processIsAlive(temporaryProjectPid)
          && !lifecycleHasCoordination(api.provider, temporaryPort.id)
          && api.provider.getProjectStatus(temporaryPort.id) === 'active';
      },
      () => `Stop did not return control to the saved-port listener: ${JSON.stringify(
        lifecycleEvidence(api.provider, temporaryPort.id)
      )}`
    );
    assert.equal(
      processIsAlive(temporaryPortBlocker.pid),
      true,
      'Stopping the temporary-port launch terminated the saved-port blocker.'
    );
    await cleanupSmokeProcess(
      smokeRoot,
      temporaryPortBlocker,
      temporaryPortBlockerRecord,
      'The temporary-port blocker did not exit.'
    );
    await markSmokeProcessExited(smokeRoot, temporaryPortBlockerRecord);
    temporaryPortBlocker = undefined;
    temporaryPortBlockerRecord = undefined;

    assert.equal(await api.provider.startProject(handoffSource.id), true, 'Runlist did not start the handoff source.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return api.provider.getProjectStatus(handoffSource.id) === 'running';
      },
      'The handoff source did not become ready.',
      10000
    );
    const handoffSourcePid = Number(fs.readFileSync(path.join(smokeRoot, 'handoff-source.pid'), 'utf8'));
    assert.equal(
      await api.provider.handoffProject(handoffTarget.id),
      true,
      'Runlist did not switch between two projects it safely owned.'
    );
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return api.provider.getProjectStatus(handoffSource.id) === 'port-in-use'
          && api.provider.getProjectStatus(handoffTarget.id) === 'running';
      },
      'The managed handoff did not complete.',
      10000
    );
    handoffTargetPid = Number(fs.readFileSync(path.join(smokeRoot, 'handoff-target.pid'), 'utf8'));
    assert.equal(processIsAlive(handoffSourcePid), false, 'Managed handoff left the source process running.');
    assert.equal(processIsAlive(handoffTargetPid), true, 'Managed handoff did not leave the target running.');
    assert.equal(
      lifecycleHasCoordination(api.provider, handoffSource.id),
      false,
      `Managed handoff retained source coordination: ${JSON.stringify(
        lifecycleEvidence(api.provider, handoffSource.id)
      )}`
    );
    assert.equal(
      lifecycleIsRunning(api.provider, handoffTarget.id),
      true,
      `Managed handoff did not transfer complete coordination: ${JSON.stringify(
        lifecycleEvidence(api.provider, handoffTarget.id)
      )}`
    );
    assert.equal(await api.provider.stopProject(handoffTarget.id), true, 'Runlist did not stop the handoff target.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return !processIsAlive(handoffTargetPid)
          && lifecycleIsStopped(api.provider, handoffTarget.id);
      },
      () => `Stop left handoff target lifecycle evidence behind: ${JSON.stringify(
        lifecycleEvidence(api.provider, handoffTarget.id)
      )}`
    );

    orphanRecovery = spawn(nodePath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    orphanRecoveryProcessRecord = await registerSmokeProcess(smokeRoot, orphanRecovery, {
      kind: 'orphan-recovery-helper',
      name: 'Orphan recovery smoke helper',
      terminateTree: false
    });
    await waitFor(
      () => processIsAlive(orphanRecovery.pid),
      'The orphan recovery fixture did not start.'
    );
    fs.writeFileSync(path.join(smokeRoot, 'orphan-recovery.pid'), String(orphanRecovery.pid));
    const { upsertProject } = require(path.join(extension.extensionPath, 'src', 'projects', 'project-store'));
    upsertProject(api.projectsFile, {
      ...manual,
      stopCommand: command(nodePath, '-e', `process.kill(${orphanRecovery.pid})`)
    });
    const ownershipPath = path.join(
      api.provider.processOwnership.directory,
      `${crypto.createHash('sha256').update(manual.id).digest('hex')}.json`
    );
    fs.writeFileSync(ownershipPath, JSON.stringify({
      projectId: manual.id,
      hostPid: 2147483647,
      childPid: orphanRecovery.pid,
      platform: process.platform,
      state: 'running',
      token: crypto.randomUUID()
    }));
    await api.provider.refreshProjectStatuses();
    assert.equal(
      api.provider.getProjectStatus(manual.id),
      'ownership-lost',
      'A live process with an unavailable owner was not shown as control unavailable.'
    );
    const confirmCustomStopCommand = api.provider.confirmCustomStopCommand;
    api.provider.confirmCustomStopCommand = async (project) => project.id === manual.id;
    try {
      assert.equal(
        await api.provider.stopProject(manual.id),
        true,
        'Runlist did not use the explicit custom stop command for orphan recovery.'
      );
    } finally {
      api.provider.confirmCustomStopCommand = confirmCustomStopCommand;
    }
    await waitFor(
      () => !processIsAlive(orphanRecovery.pid),
      'The explicit custom stop command left the orphan recovery fixture running.'
    );
    await waitFor(
      async () => !(await exactProcessIsAlive(orphanRecoveryProcessRecord)),
      'The orphan recovery helper identity did not exit.'
    );
    await markSmokeProcessExited(smokeRoot, orphanRecoveryProcessRecord);
    orphanRecoveryProcessRecord = undefined;
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return lifecycleIsStopped(api.provider, manual.id);
      },
      () => `Orphan recovery did not clear lifecycle coordination: ${JSON.stringify(
        lifecycleEvidence(api.provider, manual.id)
      )}`
    );

    assert.equal(await api.provider.startProject(failure.id), true, 'Runlist did not launch the failure fixture.');
    const { readProjectDiagnostics } = require(path.join(extension.extensionPath, 'src', 'projects', 'project-diagnostics'));
    await waitFor(
      () => Boolean(readProjectDiagnostics(api.projectsFile, failure.id)),
      'The failed start did not retain diagnostics.',
      10000
    );
    const diagnostics = readProjectDiagnostics(api.projectsFile, failure.id);
    assert.match(diagnostics.failureSummary.message, /controlled smoke failure/i);
    assert.equal(api.provider.getProjectStatus(failure.id), 'stopped', JSON.stringify({
      output: api.provider.projectOutputs.get(failure.id),
      ownership: api.provider.processOwnership.currentOwnership(failure.id),
      status: api.provider.getProjectStatus(failure.id)
    }));
    assert.equal(
      lifecycleIsStopped(api.provider, failure.id),
      true,
      `Failed Start retained lifecycle coordination: ${JSON.stringify(
        lifecycleEvidence(api.provider, failure.id)
      )}`
    );

    assert.equal(
      await vscode.commands.executeCommand('runlist.copySupportDiagnostics'),
      true,
      'The registered support diagnostics command did not complete.'
    );
    const supportReport = await vscode.env.clipboard.readText();
    assertSupportDiagnostics(supportReport, {
      project: manual,
      failureText: diagnostics.failureSummary.message
    });

    const { removeProject } = require(path.join(extension.extensionPath, 'src', 'projects', 'project-store'));
    assert.equal(removeProject(api.projectsFile, manual.id), true, 'The stopped manual fixture was not removed.');
    api.provider.renderProjectList();
    assert.equal(api.provider.projects.some((project) => project.id === manual.id), false);
  } finally {
    const cleanupFailures = [];
    await settleCleanup(async () => {
      if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
        .includes(api.provider.getProjectStatus(ready.id))) {
        await api.provider.stopProject(ready.id);
      }
    });
    await settleCleanup(async () => {
      if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
        .includes(api.provider.getProjectStatus(delayed.id))) {
        await api.provider.stopProject(delayed.id);
      }
    });
    await settleCleanup(async () => {
      if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
        .includes(api.provider.getProjectStatus(handoffSource.id))) {
        await api.provider.stopProject(handoffSource.id);
      }
    });
    await settleCleanup(async () => {
      if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
        .includes(api.provider.getProjectStatus(handoffTarget.id))) {
        await api.provider.stopProject(handoffTarget.id);
      }
    });
    await settleCleanup(() => cleanupSpawnedSmokeProcess(
      smokeRoot,
      externalListener,
      externalListenerProcessRecord,
      'The external listener did not exit.'
    ), cleanupFailures);
    await settleCleanup(() => cleanupSpawnedSmokeProcess(
      smokeRoot,
      temporaryPortBlocker,
      temporaryPortBlockerRecord,
      'The temporary-port blocker did not exit.'
    ), cleanupFailures);
    await settleCleanup(() => cleanupSpawnedSmokeProcess(
      smokeRoot,
      unrelated,
      unrelatedProcessRecord,
      'The unrelated sentinel did not exit.'
    ), cleanupFailures);
    await settleCleanup(() => cleanupSpawnedSmokeProcess(
      smokeRoot,
      orphanRecovery,
      orphanRecoveryProcessRecord,
      'The orphan recovery fixture did not exit.'
    ), cleanupFailures);
    if (cleanupFailures.length) {
      throw new Error(`Smoke helper cleanup failed: ${cleanupFailures.map((error) => error.message).join('; ')}`);
    }
  }

  process.stdout.write('Smoke reload, lifecycle, exact process-tree Stop, custom Stop, delayed readiness, external conflict, temporary ports, managed handoff, orphan recovery, retained failure, support diagnostics, and removal passed.\n');
}

function assertInside(filePath, root, message) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), message);
}

function lifecycleHasCoordination(provider, projectId) {
  return provider.processOwnership.snapshot().has(projectId)
    || provider.portReservations.snapshot().has(projectId)
    || provider.processes.has(projectId)
    || provider.startAttempts.has(projectId)
    || provider.stoppingProjectIds.has(projectId);
}

function lifecycleIsRunning(provider, projectId) {
  return provider.getProjectStatus(projectId) === 'running'
    && provider.processOwnership.snapshot().has(projectId)
    && provider.portReservations.snapshot().has(projectId)
    && provider.processes.has(projectId);
}

function lifecycleIsStopped(provider, projectId) {
  return provider.getProjectStatus(projectId) === 'stopped'
    && !lifecycleHasCoordination(provider, projectId);
}

function lifecycleEvidence(provider, projectId) {
  const ownership = provider.processOwnership.snapshot().get(projectId);
  return {
    status: provider.getProjectStatus(projectId),
    ownership: ownership ? {
      childPid: ownership.childPid,
      ownerAvailable: ownership.ownerAvailable,
      processActive: ownership.processActive,
      state: ownership.state,
      token: ownership.token
    } : undefined,
    portReservation: provider.portReservations.snapshot().get(projectId),
    localProcess: provider.processes.has(projectId),
    startAttempt: provider.startAttempts.has(projectId),
    stopping: provider.stoppingProjectIds.has(projectId)
  };
}

function assertSupportDiagnostics(report, sensitive) {
  const parsed = JSON.parse(report);
  assert.match(
    parsed.privacy,
    /exclude project names, folders, commands, environment values, ports, process IDs, and process output/i
  );
  assert.ok(parsed.projects.length > 0, 'Support diagnostics omitted the project state snapshot.');
  assert.ok(parsed.recentEvents.length > 0, 'Support diagnostics omitted lifecycle events.');
  assert.equal(
    parsed.recentEvents.some((event) => event.event === 'restart.complete'),
    true,
    'Support diagnostics did not retain the completed Restart operation.'
  );
  const restart = parsed.recentEvents.find((event) => event.event === 'restart.begin');
  assert.ok(restart?.operationId, 'Restart diagnostics did not expose a correlation identifier.');
  const correlatedEvents = parsed.recentEvents
    .filter((event) => event.operationId === restart.operationId)
    .map((event) => event.event);
  for (const event of [
    'restart.begin',
    'stop.begin',
    'stop.complete',
    'start.begin',
    'start.complete',
    'restart.complete'
  ]) {
    assert.ok(correlatedEvents.includes(event), `Restart diagnostics omitted ${event}.`);
  }
  assert.equal(
    parsed.recentEvents.some((event) => Object.hasOwn(event, 'detail')),
    false,
    'Default support diagnostics unexpectedly included trace details.'
  );
  const serialized = JSON.stringify(parsed);
  for (const secret of [
    sensitive.project.id,
    sensitive.project.name,
    sensitive.project.folder,
    sensitive.project.startCommand,
    sensitive.failureText
  ]) {
    assert.equal(serialized.includes(secret), false, `Support diagnostics leaked ${secret}.`);
  }
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

async function cleanupSpawnedSmokeProcess(smokeRoot, child, processRecord, message) {
  if (!child && !processRecord) {
    return;
  }
  await cleanupSmokeProcess(smokeRoot, child, processRecord, message);
}

async function settleCleanup(operation, failures) {
  try {
    await operation();
  } catch (error) {
    if (failures) {
      failures.push(error);
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function fixtureProcess(processes, pid) {
  const processRecord = processes.find((candidate) => candidate.pid === pid);
  assert.ok(processRecord?.identity, `Missing exact fixture identity for PID ${pid}.`);
  return processRecord;
}

async function exactProcessIsAlive(processRecord) {
  try {
    return (await readRootProcess(processRecord.pid, process.platform))?.identity
      === processRecord.identity;
  } catch {
    return false;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} was not provided to the extension host.`);
  return value;
}

function command(...parts) {
  return parts.map((part) => `"${String(part).replaceAll('"', '\\"')}"`).join(' ');
}

module.exports = { run };
