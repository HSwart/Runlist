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
  const failure = api.provider.projects.find((project) => project.name === 'Failure smoke project');
  const manual = api.provider.projects.find((project) => project.name === 'Manual smoke project');
  assert.ok(ready && failure && manual, 'Saved projects did not reload in the second extension host.');
  assert.equal(api.provider.projects.length, 4, 'The second extension host loaded incomplete saved state.');

  const fixturePidPath = path.join(smokeRoot, 'ready.pid');
  assert.equal(fs.existsSync(fixturePidPath), true, 'The first extension host did not leave reload fixture evidence.');
  const preReloadPid = Number(fs.readFileSync(fixturePidPath, 'utf8'));
  await waitFor(
    () => !processIsAlive(preReloadPid),
    'Closing the first extension host left its owned process running.'
  );
  await waitFor(
    async () => {
      await api.provider.refreshProjectStatuses();
      return api.provider.getProjectStatus(ready.id) === 'stopped';
    },
    'The reloaded extension host did not observe the previous process as stopped.'
  );
  fs.rmSync(fixturePidPath, { force: true });

  const unrelated = spawn(nodePath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  });
  fs.writeFileSync(path.join(smokeRoot, 'unrelated.pid'), String(unrelated.pid));
  let orphanRecovery;

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
    assert.equal(processIsAlive(fixturePid), true, 'The ready fixture exited before Stop was tested.');
    assert.equal(processIsAlive(unrelated.pid), true, 'The unrelated sentinel exited before Stop was tested.');

    fs.rmSync(fixturePidPath, { force: true });
    assert.equal(await api.provider.restartProject(ready.id), true, 'Runlist did not restart its ready fixture.');
    await waitFor(
      async () => {
        await api.provider.refreshProjectStatuses();
        return api.provider.getProjectStatus(ready.id) === 'running'
          && fs.existsSync(fixturePidPath);
      },
      'The restarted fixture never became ready.',
      20000
    );
    const restartedPid = Number(fs.readFileSync(fixturePidPath, 'utf8'));
    assert.notEqual(restartedPid, fixturePid, 'Restart reused the previous fixture process.');
    assert.equal(processIsAlive(fixturePid), false, 'Restart left the previous fixture process running.');

    assert.equal(await api.provider.stopProject(ready.id), true, 'Runlist did not stop its restarted fixture.');
    await waitFor(() => !processIsAlive(restartedPid), 'Stop left a descendant of the owned fixture running.');
    assert.equal(processIsAlive(unrelated.pid), true, 'Lifecycle actions terminated an unrelated process.');

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
    if (processIsAlive(unrelated.pid)) {
      unrelated.kill();
      await waitFor(() => !processIsAlive(unrelated.pid), 'The unrelated sentinel did not exit.', 5000);
    }
    if (orphanRecovery && processIsAlive(orphanRecovery.pid)) {
      orphanRecovery.kill();
      await waitFor(() => !processIsAlive(orphanRecovery.pid), 'The orphan recovery fixture did not exit.', 5000);
    }
  }

  process.stdout.write('Smoke reload, lifecycle, orphan recovery, retained failure, removal, and exact-owned Stop passed.\n');
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
  assert.fail(message);
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
