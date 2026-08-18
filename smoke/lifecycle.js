const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');

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
  const manual = api.provider.projects.find((project) => project.name === 'Manual smoke project');
  assert.ok(
    ready && customStop && delayed && externalConflict && handoffSource && handoffTarget && failure && manual,
    'Saved projects did not reload in the second extension host.'
  );
  assert.equal(api.provider.projects.length, 9, 'The second extension host loaded incomplete saved state.');

  const fixturePidPath = path.join(smokeRoot, 'ready.pid');
  const childPidPath = path.join(smokeRoot, 'ready-child.pid');
  const grandchildPidPath = path.join(smokeRoot, 'ready-grandchild.pid');
  assert.equal(fs.existsSync(fixturePidPath), true, 'The first extension host did not leave reload fixture evidence.');
  const preReloadPid = Number(fs.readFileSync(fixturePidPath, 'utf8'));
  const preReloadChildPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  const preReloadGrandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'));
  const customStopPid = Number(fs.readFileSync(path.join(smokeRoot, 'custom-stop.pid'), 'utf8'));
  await waitFor(
    () => [preReloadPid, preReloadChildPid, preReloadGrandchildPid]
      .every((pid) => !processIsAlive(pid)),
    () => {
      const processState = [preReloadPid, preReloadChildPid, preReloadGrandchildPid]
        .map((pid) => ({ pid, alive: processIsAlive(pid) }));
      const ownership = api.provider.processOwnership.snapshot().get(ready.id);
      const reservation = api.provider.portReservations.snapshot().get(ready.id);
      return `Closing the first extension host left part of its owned process tree running: ${JSON.stringify({ processState, ownership, reservation })}`;
    }
  );
  await waitFor(
    () => !processIsAlive(customStopPid),
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
      return api.provider.getProjectStatus(ready.id) === 'stopped';
    },
    'The reloaded extension host did not observe the previous process as stopped.'
  );
  fs.rmSync(fixturePidPath, { force: true });
  fs.rmSync(childPidPath, { force: true });
  fs.rmSync(grandchildPidPath, { force: true });

  const unrelated = spawn(nodePath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  });
  fs.writeFileSync(path.join(smokeRoot, 'unrelated.pid'), String(unrelated.pid));
  let orphanRecovery;
  let delayedPid;
  let externalListener;
  let handoffTargetPid;

  try {
    assert.equal(await api.provider.startProject(ready.id), true, 'Runlist did not start the ready fixture.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return api.provider.getProjectStatus(ready.id) === 'running';
      },
      `Ready fixture never became ready; last status was ${api.provider.getProjectStatus(ready.id)}.`,
      20000
    );

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

    assert.equal(await api.provider.restartProject(ready.id), true, 'Runlist did not restart its ready fixture.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return api.provider.getProjectStatus(ready.id) === 'running'
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
    assert.notEqual(restartedPid, fixturePid, 'Restart reused the previous fixture process.');
    assert.notEqual(restartedChildPid, childPid, 'Restart reused the previous fixture child process.');
    assert.notEqual(restartedGrandchildPid, grandchildPid, 'Restart reused the previous fixture grandchild process.');
    await waitFor(
      () => [fixturePid, childPid, grandchildPid].every((pid) => !processIsAlive(pid)),
      'Restart left part of the previous fixture process tree running.'
    );

    api.provider.projectStatuses.set(ready.id, 'stopping');
    api.provider.stoppingProjectIds.delete(ready.id);
    assert.equal(await api.provider.stopProject(ready.id), true, 'Runlist did not stop its restarted fixture.');
    await waitFor(
      () => [restartedPid, restartedChildPid, restartedGrandchildPid]
        .every((pid) => !processIsAlive(pid)),
      'Stop left part of the owned fixture process tree running.'
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
    await waitFor(() => !processIsAlive(delayedPid), 'Stop left the delayed fixture running.');

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
      fs.existsSync(path.join(smokeRoot, 'external-conflict-started.pid')),
      false,
      'The blocked external-conflict start command still executed.'
    );
    externalListener.kill();
    await waitFor(() => !processIsAlive(externalListener.pid), 'The external listener did not exit.');
    externalListener = undefined;
    await api.provider.refreshProjectStatuses();

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
    assert.equal(await api.provider.stopProject(handoffTarget.id), true, 'Runlist did not stop the handoff target.');
    await waitFor(() => !processIsAlive(handoffTargetPid), 'Stop left the handoff target running.');

    orphanRecovery = spawn(nodePath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    fs.writeFileSync(path.join(smokeRoot, 'orphan-recovery.pid'), String(orphanRecovery.pid));
    const { upsertProject } = require(path.join(extension.extensionPath, 'project-store'));
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
    assert.equal(
      await api.provider.stopProject(manual.id),
      true,
      'Runlist did not use the explicit custom stop command for orphan recovery.'
    );
    await waitFor(
      () => !processIsAlive(orphanRecovery.pid),
      'The explicit custom stop command left the orphan recovery fixture running.'
    );

    assert.equal(await api.provider.startProject(failure.id), true, 'Runlist did not launch the failure fixture.');
    const { readProjectDiagnostics } = require(path.join(extension.extensionPath, 'project-diagnostics'));
    await waitFor(
      () => Boolean(readProjectDiagnostics(api.projectsFile, failure.id)),
      'The failed start did not retain diagnostics.',
      10000
    );
    const diagnostics = readProjectDiagnostics(api.projectsFile, failure.id);
    assert.match(diagnostics.failureSummary.message, /controlled smoke failure/i);
    assert.equal(api.provider.getProjectStatus(failure.id), 'stopped');

    const { removeProject } = require(path.join(extension.extensionPath, 'project-store'));
    assert.equal(removeProject(api.projectsFile, manual.id), true, 'The stopped manual fixture was not removed.');
    api.provider.renderProjectList();
    assert.equal(api.provider.projects.some((project) => project.id === manual.id), false);
  } finally {
    if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
      .includes(api.provider.getProjectStatus(ready.id))) {
      await api.provider.stopProject(ready.id);
    }
    if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
      .includes(api.provider.getProjectStatus(delayed.id))) {
      await api.provider.stopProject(delayed.id);
    }
    if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
      .includes(api.provider.getProjectStatus(handoffSource.id))) {
      await api.provider.stopProject(handoffSource.id);
    }
    if (['running', 'starting', 'not-ready', 'not-responding', 'stopping']
      .includes(api.provider.getProjectStatus(handoffTarget.id))) {
      await api.provider.stopProject(handoffTarget.id);
    }
    if (externalListener && processIsAlive(externalListener.pid)) {
      externalListener.kill();
      await waitFor(() => !processIsAlive(externalListener.pid), 'The external listener did not exit.', 5000);
    }
    if (processIsAlive(unrelated.pid)) {
      unrelated.kill();
      await waitFor(() => !processIsAlive(unrelated.pid), 'The unrelated sentinel did not exit.', 5000);
    }
    if (orphanRecovery && processIsAlive(orphanRecovery.pid)) {
      orphanRecovery.kill();
      await waitFor(() => !processIsAlive(orphanRecovery.pid), 'The orphan recovery fixture did not exit.', 5000);
    }
  }

  process.stdout.write('Smoke reload, lifecycle, exact process-tree Stop, custom Stop, delayed readiness, external conflict, managed handoff, orphan recovery, retained failure, and removal passed.\n');
}

function assertInside(filePath, root, message) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), message);
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

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
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
