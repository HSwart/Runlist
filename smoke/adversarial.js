const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');
const { readRootProcess } = require('../src/lifecycle/process-metrics');
const {
  ProcessOwnershipStore,
  readProcessIdentitySync
} = require('../src/lifecycle/project-process');
const {
  cleanupSmokeProcess,
  markSmokeProcessExited,
  readSmokePidFromFile,
  registerSmokeProcess,
  terminateSmokeProcess
} = require('./run');

async function run() {
  const smokeRoot = requiredEnvironment('RUNLIST_SMOKE_ROOT');
  const nodePath = requiredEnvironment('RUNLIST_SMOKE_NODE');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspacePath, 'The isolated adversarial workspace did not open.');

  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  assert.ok(extension, 'The Runlist development extension was not installed.');
  const api = await extension.activate();
  assert.ok(api?.provider, 'The extension did not expose its guarded smoke API.');
  await vscode.commands.executeCommand('workbench.view.extension.runlist');
  await vscode.commands.executeCommand('runlist.projects.focus');
  await waitFor(() => Boolean(api.provider.view), 'The Runlist view did not open.');

  const context = {
    api,
    extension,
    idlePath: path.join(extension.extensionPath, 'smoke', 'fixtures', 'idle.js'),
    nodePath,
    smokeRoot,
    workspacePath
  };

  await rootExitScenario(context);
  await execIdentityScenario(context);
  await independentOwnerScenario(context);
  await concurrentStopRestartScenario(context);
  await externalPortScenario(context);
  await customStopFailureScenario(context);
  await partialStorageFailureScenario(context);

  await api.provider.dispose();
  process.stdout.write('Adversarial root-exit, exec identity, owner crash, PID replacement, concurrent lifecycle, external-port confirmation, custom Stop failure, and partial-storage scenarios passed.\n');
}

async function rootExitScenario(context) {
  const { api, extension, nodePath, smokeRoot, workspacePath } = context;
  const rootPidPath = path.join(smokeRoot, 'root-exit-root.pid');
  const childPidPath = path.join(smokeRoot, 'root-exit-child.pid');
  const runCountPath = path.join(smokeRoot, 'root-exit-count');
  const exitSignalPath = path.join(smokeRoot, 'root-exit-now');
  const fixturePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'root-exits.js');
  const project = await saveProject(api.provider, {
    name: 'Root exit adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-root-exit'),
    startCommand: command(
      nodePath,
      fixturePath,
      rootPidPath,
      childPidPath,
      runCountPath,
      exitSignalPath
    )
  });

  assert.equal(await api.provider.startProject(project.id), true, 'The root-exit fixture did not start.');
  await waitFor(
    () => fs.existsSync(rootPidPath) && fs.existsSync(childPidPath),
    'The root-exit fixture did not expose its process tree.'
  );
  const firstRoot = await registerSmokeProcess(
    smokeRoot,
    Number(fs.readFileSync(rootPidPath, 'utf8')),
    { kind: 'root-exit-root', terminateTree: false }
  );
  const firstChild = await registerSmokeProcess(
    smokeRoot,
    Number(fs.readFileSync(childPidPath, 'utf8')),
    { kind: 'root-exit-descendant', terminateTree: false }
  );
  assert.equal(await exactProcessIsAlive(firstChild), true, 'The descendant was not alive before its root exited.');
  assert.equal(api.provider.processOwnership.snapshot().has(project.id), true, 'Root exit Start omitted ownership.');
  if (process.platform === 'win32') {
    const tracked = api.provider.processes.get(project.id);
    const capturedTree = await tracked?.runlistProcessTree;
    assert.equal(
      capturedTree?.some((row) => row.pid === firstChild.pid),
      true,
      `Runlist did not capture the Windows descendant before releasing Start: ${JSON.stringify(capturedTree || [])}`
    );
  }
  fs.writeFileSync(exitSignalPath, 'exit\n');

  await waitFor(
    async () => !(await exactProcessIsAlive(firstRoot))
      && !(await exactProcessIsAlive(firstChild))
      && lifecycleIsStopped(api.provider, project.id),
    () => `Root exit abandoned its descendant or coordination: ${JSON.stringify(lifecycleEvidence(api.provider, project.id))}`,
    15000
  );
  await markSmokeProcessExited(smokeRoot, firstRoot);
  await markSmokeProcessExited(smokeRoot, firstChild);

  fs.rmSync(rootPidPath, { force: true });
  fs.rmSync(childPidPath, { force: true });
  fs.rmSync(exitSignalPath, { force: true });
  assert.equal(await api.provider.startProject(project.id), true, 'The project did not recover after root-exit cleanup.');
  await waitFor(
    () => fs.existsSync(rootPidPath) && fs.existsSync(childPidPath),
    'The recovery launch did not expose its process tree.'
  );
  const secondRoot = await registerSmokeProcess(
    smokeRoot,
    Number(fs.readFileSync(rootPidPath, 'utf8')),
    { kind: 'root-exit-recovery-root', terminateTree: false }
  );
  const secondChild = await registerSmokeProcess(
    smokeRoot,
    Number(fs.readFileSync(childPidPath, 'utf8')),
    { kind: 'root-exit-recovery-descendant', terminateTree: false }
  );
  await waitFor(
    () => api.provider.getProjectStatus(project.id) === 'running'
      && api.provider.processOwnership.snapshot().has(project.id),
    'The recovery launch did not reach a coordinated running state.'
  );
  assert.equal(await api.provider.stopProject(project.id), true, 'Stop failed after root-exit recovery.');
  await waitFor(
    async () => !(await exactProcessIsAlive(secondRoot))
      && !(await exactProcessIsAlive(secondChild))
      && lifecycleIsStopped(api.provider, project.id),
    'Stop did not recover the second root-exit generation.'
  );
  await markSmokeProcessExited(smokeRoot, secondRoot);
  await markSmokeProcessExited(smokeRoot, secondChild);
}

async function execIdentityScenario(context) {
  const { api, idlePath, nodePath, smokeRoot, workspacePath } = context;
  const pidPath = path.join(smokeRoot, 'exec-identity.pid');
  const baseCommand = command(nodePath, idlePath, pidPath);
  const project = await saveProject(api.provider, {
    name: 'Exec identity adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-exec'),
    startCommand: process.platform === 'win32' ? baseCommand : `exec ${baseCommand}`
  });

  assert.equal(await api.provider.startProject(project.id), true, 'The exec fixture did not start.');
  const target = await registerSmokeProcess(
    smokeRoot,
    await readSmokePidFromFile(pidPath, 'The exec fixture did not expose its process id.'),
    { kind: 'exec-identity-target', terminateTree: false }
  );
  await waitFor(() => {
    const ownership = api.provider.processOwnership.snapshot().get(project.id);
    return api.provider.getProjectStatus(project.id) === 'running'
      && typeof ownership?.childIdentity === 'string';
  }, 'The exec launch lost its exact ownership identity.');
  assert.equal(await api.provider.stopProject(project.id), true, 'The exec launch rejected exact Stop.');
  await waitFor(
    async () => !(await exactProcessIsAlive(target)) && lifecycleIsStopped(api.provider, project.id),
    'The exec launch did not stop cleanly.'
  );
  await markSmokeProcessExited(smokeRoot, target);
}

async function independentOwnerScenario(context) {
  const { api, idlePath, nodePath, smokeRoot, workspacePath } = context;
  const crashProject = await saveProject(api.provider, {
    name: 'Crashed owner adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-crashed-owner'),
    startCommand: command(nodePath, idlePath, path.join(smokeRoot, 'crash-recovery-launch.pid'))
  });
  const reusedProject = await saveProject(api.provider, {
    name: 'PID replacement adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-pid-replacement'),
    startCommand: command(nodePath, idlePath, path.join(smokeRoot, 'pid-recovery-launch.pid'))
  });
  const foreignHost = spawn(nodePath, [idlePath, path.join(smokeRoot, 'foreign-host.pid')], {
    stdio: 'ignore', windowsHide: true
  });
  const crashTarget = spawn(nodePath, [idlePath, path.join(smokeRoot, 'crash-target.pid')], {
    stdio: 'ignore', windowsHide: true
  });
  const reusedTarget = spawn(nodePath, [idlePath, path.join(smokeRoot, 'reused-target.pid')], {
    stdio: 'ignore', windowsHide: true
  });
  const hostRecord = await registerSmokeProcess(smokeRoot, foreignHost, {
    kind: 'independent-owner-host', terminateTree: false
  });
  const crashRecord = await registerSmokeProcess(smokeRoot, crashTarget, {
    kind: 'crashed-owner-target', terminateTree: false
  });
  const reusedRecord = await registerSmokeProcess(smokeRoot, reusedTarget, {
    kind: 'pid-replacement-target', terminateTree: false
  });
  const foreignHostIdentity = readProcessIdentitySync(foreignHost.pid, process.platform);
  assert.ok(foreignHostIdentity, 'The independent owner host did not expose its host identity.');
  const foreignOwnership = new ProcessOwnershipStore(api.provider.processOwnership.directory, {
    pid: foreignHost.pid,
    hostIdentity: foreignHostIdentity
  });
  assert.equal(foreignOwnership.reserve(crashProject.id), undefined);
  assert.equal(foreignOwnership.reserve(reusedProject.id), undefined);
  foreignOwnership.setProcess(crashProject.id, crashTarget.pid, {
    childIdentity: crashRecord.identity,
    cwd: crashProject.folder,
    startCommand: crashProject.startCommand,
    state: 'running'
  });
  foreignOwnership.setProcess(reusedProject.id, reusedTarget.pid, {
    childIdentity: reusedRecord.identity,
    cwd: reusedProject.folder,
    startCommand: reusedProject.startCommand,
    state: 'running'
  });

  await api.provider.refreshProjectStatuses();
  const ownershipBeforeStart = api.provider.projectRuntime.get(crashProject.id);
  assert.ok(ownershipBeforeStart, 'The independent owner disappeared before competing Start.');
  assert.equal(
    ownershipBeforeStart.processActive,
    true,
    'The independent owner target was not visible as active before competing Start.'
  );
  assert.equal(
    api.provider.getProjectStatus(crashProject.id),
    ownershipBeforeStart.ownerAvailable ? 'running' : 'ownership-lost',
    'The displayed status did not match the available ownership evidence.'
  );
  assert.equal(await api.provider.startProject(crashProject.id), false, 'A second host replaced a live owner.');
  assert.equal(await exactProcessIsAlive(crashRecord), true, 'Competing Start terminated the owned target.');
  assert.equal(
    api.provider.processOwnership.snapshot().get(crashProject.id)?.token,
    ownershipBeforeStart.token,
    'Competing Start replaced or removed foreign ownership.'
  );

  await terminateSmokeProcess(hostRecord);
  await markSmokeProcessExited(smokeRoot, hostRecord);
  const reusedOwnershipPath = foreignOwnership.ownershipPath(reusedProject.id);
  const reusedOwnership = JSON.parse(fs.readFileSync(reusedOwnershipPath, 'utf8'));
  fs.writeFileSync(reusedOwnershipPath, JSON.stringify({
    ...reusedOwnership,
    childIdentity: changedIdentity(reusedRecord.identity)
  }));

  await waitFor(async () => {
    await api.provider.refreshProjectStatuses();
    return api.provider.getProjectStatus(crashProject.id) === 'ownership-lost'
      && lifecycleIsStopped(api.provider, reusedProject.id);
  }, () => `Crash/PID replacement did not reach safe evidence states: ${JSON.stringify({
    crash: lifecycleEvidence(api.provider, crashProject.id),
    reused: lifecycleEvidence(api.provider, reusedProject.id)
  })}`);
  assert.equal(await exactProcessIsAlive(crashRecord), true, 'Owner crash terminated the exact target without a Stop action.');
  assert.equal(await exactProcessIsAlive(reusedRecord), true, 'PID replacement cleanup signaled the replacement process.');

  await terminateSmokeProcess(crashRecord);
  await markSmokeProcessExited(smokeRoot, crashRecord);
  await terminateSmokeProcess(reusedRecord);
  await markSmokeProcessExited(smokeRoot, reusedRecord);
  await waitFor(async () => {
    await api.provider.refreshProjectStatuses();
    return lifecycleIsStopped(api.provider, crashProject.id)
      && lifecycleIsStopped(api.provider, reusedProject.id);
  }, 'Crashed ownership did not recover after the exact targets exited.');

  await startAndStopIdleProject(api.provider, crashProject, smokeRoot, 'crash-recovery-launch.pid');
  await startAndStopIdleProject(api.provider, reusedProject, smokeRoot, 'pid-recovery-launch.pid');
}

async function concurrentStopRestartScenario(context) {
  const { api, extension, nodePath, smokeRoot, workspacePath } = context;
  const port = await availablePort();
  const pidPath = path.join(smokeRoot, 'concurrent-ready.pid');
  const project = await saveProject(api.provider, {
    name: 'Concurrent lifecycle adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-concurrent'),
    startCommand: command(
      nodePath,
      path.join(extension.extensionPath, 'smoke', 'fixtures', 'ready.js'),
      smokeRoot,
      String(port),
      '', '', '0', pidPath
    ),
    services: [{ name: 'web', port: String(port), url: '' }]
  });
  assert.equal(await api.provider.startProject(project.id), true, 'The concurrent fixture did not start.');
  await waitFor(async () => {
    await api.provider.refreshProjectStatuses();
    return lifecycleIsRunning(api.provider, project.id) && fs.existsSync(pidPath);
  }, 'The concurrent fixture did not become ready.', 15000);
  const oldProcess = await registerSmokeProcess(
    smokeRoot,
    await readSmokePidFromFile(pidPath, 'The concurrent fixture did not expose a valid process id.', 15000),
    { kind: 'concurrent-old-generation', ports: [port], terminateTree: false }
  );
  fs.rmSync(pidPath, { force: true });

  const [restartResult, stopResult] = await Promise.all([
    api.provider.restartProject(project.id),
    api.provider.stopProject(project.id)
  ]);
  assert.equal(
    restartResult || stopResult,
    true,
    `Concurrent Restart and Stop both rejected without settling: ${JSON.stringify({
      restartResult,
      stopResult,
      ...lifecycleEvidence(api.provider, project.id)
    })}`
  );
  await waitFor(async () => {
    await api.provider.refreshProjectStatuses();
    return ['running', 'stopped'].includes(api.provider.getProjectStatus(project.id));
  }, () => `Concurrent lifecycle remained transitional: ${JSON.stringify(lifecycleEvidence(api.provider, project.id))}`, 20000);
  assert.equal(await exactProcessIsAlive(oldProcess), false, 'Concurrent lifecycle left the old process generation alive.');
  await markSmokeProcessExited(smokeRoot, oldProcess);

  if (api.provider.getProjectStatus(project.id) === 'stopped') {
    assert.equal(lifecycleIsStopped(api.provider, project.id), true, 'Concurrent Stop left partial coordination.');
    assert.equal(await api.provider.startProject(project.id), true, 'Start did not recover after concurrent Stop/Restart.');
  }
  await waitFor(async () => {
    await api.provider.refreshProjectStatuses();
    return lifecycleIsRunning(api.provider, project.id) && fs.existsSync(pidPath);
  }, 'Concurrent lifecycle did not recover to one running generation.', 20000);
  const recoveredProcess = await registerSmokeProcess(
    smokeRoot,
    await readSmokePidFromFile(pidPath, 'Concurrent lifecycle did not expose a valid recovered process id.', 20000),
    { kind: 'concurrent-recovered-generation', ports: [port], terminateTree: false }
  );
  assert.equal(await api.provider.stopProject(project.id), true, 'Stop failed after concurrent lifecycle recovery.');
  await waitFor(
    async () => !(await exactProcessIsAlive(recoveredProcess)) && lifecycleIsStopped(api.provider, project.id),
    'Recovered concurrent generation did not stop.'
  );
  await markSmokeProcessExited(smokeRoot, recoveredProcess);
}

async function externalPortScenario(context) {
  const { api, extension, nodePath, smokeRoot, workspacePath } = context;
  const fixturePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'ready.js');
  const closePort = await availablePort();
  const changedPort = await availablePort();
  const closeProjectPidPath = path.join(smokeRoot, 'external-close-project.pid');
  const closeProject = await saveProject(api.provider, {
    name: 'External close adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-external-close'),
    startCommand: command(nodePath, fixturePath, smokeRoot, String(closePort), '', '', '0', closeProjectPidPath),
    services: [{ name: 'web', port: String(closePort), url: '' }]
  });
  const changedProject = await saveProject(api.provider, {
    name: 'External replacement adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-external-replacement'),
    startCommand: command(
      nodePath,
      path.join(extension.extensionPath, 'smoke', 'fixtures', 'failure.js'),
      path.join(smokeRoot, 'external-replacement-started.pid')
    ),
    services: [{ name: 'web', port: String(changedPort), url: '' }]
  });

  const closeListener = await spawnReadyListener(context, closePort, 'external-close-listener');
  await api.provider.refreshProjectStatuses();
  await withWarningMessageResponder(
    `Close the processes blocking ${closeProject.name}?`,
    async (...args) => args.at(-1),
    async () => {
      assert.equal(
        await api.provider.forceCloseProjectPorts(closeProject.id, 'start'),
        true,
        'Confirmed external listener closure did not start the project.'
      );
    }
  );
  await waitFor(async () => {
    await api.provider.refreshProjectStatuses();
    return !(await exactProcessIsAlive(closeListener.record))
      && lifecycleIsRunning(api.provider, closeProject.id)
      && fs.existsSync(closeProjectPidPath);
  }, 'Confirmed external-port closure did not produce one owned running generation.', 15000);
  await markSmokeProcessExited(smokeRoot, closeListener.record);
  const closeRun = await registerSmokeProcess(
    smokeRoot,
    Number(fs.readFileSync(closeProjectPidPath, 'utf8')),
    { kind: 'external-close-runlist-generation', ports: [closePort], terminateTree: false }
  );
  assert.equal(await api.provider.stopProject(closeProject.id), true);
  await waitFor(
    async () => !(await exactProcessIsAlive(closeRun)) && lifecycleIsStopped(api.provider, closeProject.id),
    'The project did not recover after confirmed external-port closure.'
  );
  await markSmokeProcessExited(smokeRoot, closeRun);

  const firstListener = await spawnReadyListener(context, changedPort, 'external-replaced-listener');
  let replacementListener;
  await api.provider.refreshProjectStatuses();
  await withWarningMessageResponder(
    `Close the processes blocking ${changedProject.name}?`,
    async (...args) => {
      await terminateSmokeProcess(firstListener.record);
      await markSmokeProcessExited(smokeRoot, firstListener.record);
      replacementListener = await spawnReadyListener(context, changedPort, 'external-replacement-listener');
      return args.at(-1);
    },
    async () => {
      assert.equal(
        await api.provider.forceCloseProjectPorts(changedProject.id, 'start'),
        false,
        'Runlist ignored an external listener identity change after confirmation.'
      );
    }
  );
  assert.ok(replacementListener, 'The replacement listener was not installed during confirmation.');
  assert.equal(await exactProcessIsAlive(replacementListener.record), true, 'Runlist terminated the replacement listener.');
  assert.equal(lifecycleHasCoordination(api.provider, changedProject.id), false, 'Changed listener retained Runlist coordination.');
  assert.equal(fs.existsSync(path.join(smokeRoot, 'external-replacement-started.pid')), false, 'Changed listener still allowed Start.');
  await cleanupSmokeProcess(
    smokeRoot,
    replacementListener.child,
    replacementListener.record,
    'The replacement listener did not exit.'
  );
}

async function customStopFailureScenario(context) {
  const { api, extension, idlePath, nodePath, smokeRoot, workspacePath } = context;
  const targetPidPath = path.join(smokeRoot, 'custom-failure-target.pid');
  const modePath = path.join(smokeRoot, 'custom-stop-mode');
  const commandPidPath = path.join(smokeRoot, 'custom-stop-command.pid');
  const project = await saveProject(api.provider, {
    name: 'Custom Stop adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-custom-stop'),
    startCommand: command(nodePath, idlePath, targetPidPath),
    stopCommand: command(
      nodePath,
      path.join(extension.extensionPath, 'smoke', 'fixtures', 'custom-stop-control.js'),
      modePath,
      targetPidPath,
      commandPidPath
    )
  });
  assert.equal(await api.provider.startProject(project.id), true, 'The custom Stop target did not start.');
  await waitFor(() => fs.existsSync(targetPidPath), 'The custom Stop target did not expose its PID.');
  const target = await registerSmokeProcess(
    smokeRoot,
    Number(fs.readFileSync(targetPidPath, 'utf8')),
    { kind: 'custom-stop-target', terminateTree: false }
  );
  const confirm = api.provider.confirmCustomStopCommand;
  api.provider.confirmCustomStopCommand = async (candidate) => candidate.id === project.id;
  try {
    for (const mode of ['fail', 'noop']) {
      fs.writeFileSync(modePath, mode);
      fs.rmSync(commandPidPath, { force: true });
      assert.equal(await api.provider.stopProject(project.id), false, `Custom Stop ${mode} unexpectedly succeeded.`);
      assert.equal(await exactProcessIsAlive(target), true, `Custom Stop ${mode} terminated the target.`);
      assert.equal(api.provider.processOwnership.snapshot().has(project.id), true, `Custom Stop ${mode} released ownership.`);
      assert.notEqual(api.provider.getProjectStatus(project.id), 'stopped', `Custom Stop ${mode} displayed stopped.`);
    }

    fs.writeFileSync(modePath, 'hang');
    fs.rmSync(commandPidPath, { force: true });
    const hangingStop = api.provider.stopProject(project.id);
    await waitFor(() => fs.existsSync(commandPidPath), 'The hanging custom Stop did not start.');
    const hangingCommand = await registerSmokeProcess(
      smokeRoot,
      Number(fs.readFileSync(commandPidPath, 'utf8')),
      { kind: 'hanging-custom-stop-command', terminateTree: false }
    );
    assert.equal(await hangingStop, false, 'A hanging custom Stop unexpectedly succeeded.');
    await waitFor(
      async () => !(await exactProcessIsAlive(hangingCommand)),
      'Runlist left the timed-out custom Stop command alive.',
      5000
    );
    await markSmokeProcessExited(smokeRoot, hangingCommand);
    assert.equal(await exactProcessIsAlive(target), true, 'A hanging custom Stop terminated the project target.');
    assert.equal(api.provider.processOwnership.snapshot().has(project.id), true, 'A hanging custom Stop released ownership.');

    fs.writeFileSync(modePath, 'stop');
    fs.rmSync(commandPidPath, { force: true });
    assert.equal(await api.provider.stopProject(project.id), true, 'Custom Stop did not recover after prior failures.');
    await waitFor(
      async () => !(await exactProcessIsAlive(target)) && lifecycleIsStopped(api.provider, project.id),
      'Successful custom Stop did not recover lifecycle state.'
    );
    await markSmokeProcessExited(smokeRoot, target);
  } finally {
    api.provider.confirmCustomStopCommand = confirm;
  }
}

async function partialStorageFailureScenario(context) {
  const { api, idlePath, nodePath, smokeRoot, workspacePath } = context;
  const pidPath = path.join(smokeRoot, 'partial-storage.pid');
  const project = await saveProject(api.provider, {
    name: 'Partial storage adversarial project',
    folder: projectFolder(workspacePath, 'adversarial-partial-storage'),
    startCommand: command(nodePath, idlePath, pidPath)
  });
  const reserve = api.provider.portReservations.reserve.bind(api.provider.portReservations);
  api.provider.portReservations.reserve = () => {
    throw Object.assign(new Error('controlled reservation failure'), { code: 'EIO' });
  };
  try {
    assert.equal(await api.provider.startProject(project.id), false, 'Start ignored a partial reservation failure.');
  } finally {
    api.provider.portReservations.reserve = reserve;
  }
  assert.equal(fs.existsSync(pidPath), false, 'Partial reservation failure still launched the command.');
  assert.equal(lifecycleIsStopped(api.provider, project.id), true, `Partial failure retained state: ${JSON.stringify(lifecycleEvidence(api.provider, project.id))}`);
  await startAndStopIdleProject(api.provider, project, smokeRoot, 'partial-storage.pid');
}

async function startAndStopIdleProject(provider, project, smokeRoot, pidFilename) {
  const pidPath = path.join(smokeRoot, pidFilename);
  fs.rmSync(pidPath, { force: true });
  assert.equal(await provider.startProject(project.id), true, `${project.name} did not recover on Start.`);
  const processRecord = await registerSmokeProcess(
    smokeRoot,
    await readSmokePidFromFile(pidPath, `${project.name} did not expose its recovery PID.`),
    { kind: 'adversarial-recovery-target', terminateTree: false }
  );
  await waitFor(
    () => provider.getProjectStatus(project.id) === 'running'
      && provider.processOwnership.snapshot().has(project.id),
    `${project.name} did not recover to a coordinated running state.`
  );
  assert.equal(await provider.stopProject(project.id), true, `${project.name} did not recover on Stop.`);
  await waitFor(
    async () => !(await exactProcessIsAlive(processRecord)) && lifecycleIsStopped(provider, project.id),
    `${project.name} retained state after recovery Stop.`
  );
  await markSmokeProcessExited(smokeRoot, processRecord);
}

async function spawnReadyListener(context, port, kind) {
  const pidPath = path.join(context.smokeRoot, `${kind}.pid`);
  fs.rmSync(pidPath, { force: true });
  const child = spawn(context.nodePath, [
    path.join(context.extension.extensionPath, 'smoke', 'fixtures', 'ready.js'),
    context.smokeRoot,
    String(port),
    '', '', '0', pidPath
  ], { stdio: 'ignore', windowsHide: true });
  const record = await registerSmokeProcess(context.smokeRoot, child, {
    kind,
    ports: [port],
    terminateTree: false
  });
  await waitFor(() => fs.existsSync(pidPath), `${kind} did not become ready.`);
  return { child, record };
}

async function withWarningMessageResponder(expectedMessage, responder, operation) {
  const original = vscode.window.showWarningMessage;
  const guardedResponder = (...args) => args[0] === expectedMessage
    ? responder(...args)
    : undefined;
  vscode.window.showWarningMessage = guardedResponder;
  assert.equal(vscode.window.showWarningMessage, guardedResponder, 'The smoke host could not control native confirmation.');
  try {
    return await operation();
  } finally {
    vscode.window.showWarningMessage = original;
  }
}

async function saveProject(provider, input) {
  fs.mkdirSync(input.folder, { recursive: true });
  await provider.showAddProject();
  await provider.saveProject(input);
  const project = provider.projects.find((candidate) => candidate.folder === input.folder);
  assert.ok(project, `Runlist did not save ${input.name}.`);
  return project;
}

function projectFolder(workspacePath, name) {
  return path.join(workspacePath, name);
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

function changedIdentity(identity) {
  const final = identity.at(-1);
  return `${identity.slice(0, -1)}${final === '0' ? '1' : '0'}`;
}

function command(...parts) {
  return parts.map((part) => `"${String(part).replaceAll('"', '\\"')}"`).join(' ');
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
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

module.exports = { run };
