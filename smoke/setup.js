const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const vscode = require('vscode');
const { readRootProcess } = require('../src/lifecycle/process-metrics');

async function run() {
  const smokeRoot = requiredEnvironment('RUNLIST_SMOKE_ROOT');
  const nodePath = requiredEnvironment('RUNLIST_SMOKE_NODE');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspacePath, 'The isolated smoke workspace did not open.');

  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  assert.ok(extension, 'The Runlist development extension was not installed.');
  const api = await extension.activate();
  assert.ok(api?.provider, 'The extension did not expose its guarded smoke API.');
  assertInside(api.projectsFile, smokeRoot, 'Runlist storage escaped the isolated smoke profile.');

  await vscode.commands.executeCommand('workbench.view.extension.runlist');
  await vscode.commands.executeCommand('runlist.projects.focus');
  await waitFor(() => Boolean(api.provider.view), 'The Runlist view did not open.');

  const fixturePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'ready.js');
  const failurePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'failure.js');
  const idlePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'idle.js');
  const stopPath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'stop.js');
  const usedPorts = new Set();
  const port = await availableDistinctPort(usedPorts);
  const delayedPort = await availableDistinctPort(usedPorts);
  const externalPort = await availableDistinctPort(usedPorts);
  const handoffPort = await availableDistinctPort(usedPorts);
  const readyChildPidPath = path.join(smokeRoot, 'ready-child.pid');
  const readyGrandchildPidPath = path.join(smokeRoot, 'ready-grandchild.pid');
  const customStopPidPath = path.join(smokeRoot, 'custom-stop.pid');
  const delayedPidPath = path.join(smokeRoot, 'delayed.pid');

  const manual = await saveProject(api.provider, {
    name: 'Manual smoke project',
    folder: projectFolder(workspacePath, 'manual'),
    startCommand: command(nodePath, failurePath, path.join(smokeRoot, 'manual-unused.pid'))
  });
  assert.equal(manual.reviewRequired, false, 'A manually saved project should be trusted.');

  const ready = await saveProject(api.provider, {
    name: 'Ready smoke project',
    folder: projectFolder(workspacePath, 'ready'),
    startCommand: command(
      nodePath,
      fixturePath,
      smokeRoot,
      String(port),
      readyChildPidPath,
      readyGrandchildPidPath
    ),
    services: [{ name: 'web', port: String(port), url: '' }]
  });
  const customStop = await saveProject(api.provider, {
    name: 'Custom stop smoke project',
    folder: projectFolder(workspacePath, 'custom-stop'),
    startCommand: command(nodePath, idlePath, customStopPidPath),
    stopCommand: command(
      nodePath,
      stopPath,
      customStopPidPath,
      path.join(smokeRoot, 'custom-stop.used')
    )
  });
  await saveProject(api.provider, {
    name: 'Delayed smoke project',
    folder: projectFolder(workspacePath, 'delayed'),
    startCommand: command(
      nodePath,
      fixturePath,
      smokeRoot,
      String(delayedPort),
      '',
      '',
      '1000',
      delayedPidPath
    ),
    services: [{ name: 'delayed web', port: String(delayedPort), url: '' }]
  });
  await saveProject(api.provider, {
    name: 'External conflict smoke project',
    folder: projectFolder(workspacePath, 'external-conflict'),
    startCommand: command(
      nodePath,
      failurePath,
      path.join(smokeRoot, 'external-conflict-started.pid')
    ),
    services: [{ name: 'external web', port: String(externalPort), url: '' }]
  });
  await saveProject(api.provider, {
    name: 'Handoff source smoke project',
    folder: projectFolder(workspacePath, 'handoff-source'),
    startCommand: command(
      nodePath,
      fixturePath,
      smokeRoot,
      String(handoffPort),
      '',
      '',
      '0',
      path.join(smokeRoot, 'handoff-source.pid')
    ),
    services: [{ name: 'shared web', port: String(handoffPort), url: '' }]
  });
  await saveProject(api.provider, {
    name: 'Handoff target smoke project',
    folder: projectFolder(workspacePath, 'handoff-target'),
    startCommand: command(
      nodePath,
      fixturePath,
      smokeRoot,
      String(handoffPort),
      '',
      '',
      '0',
      path.join(smokeRoot, 'handoff-target.pid')
    ),
    services: [{ name: 'shared web', port: String(handoffPort), url: '' }]
  });
  await saveProject(api.provider, {
    name: 'Failure smoke project',
    folder: projectFolder(workspacePath, 'failure'),
    startCommand: command(nodePath, failurePath, path.join(smokeRoot, 'failure.pid'))
  });

  const { upsertProject } = require(path.join(extension.extensionPath, 'src', 'projects', 'project-store'));
  const untrustedFolder = projectFolder(workspacePath, 'untrusted');
  fs.mkdirSync(untrustedFolder, { recursive: true });
  const untrusted = upsertProject(api.projectsFile, {
    name: 'Untrusted smoke project',
    folder: untrustedFolder,
    startCommand: command(nodePath, failurePath, path.join(smokeRoot, 'untrusted-unused.pid')),
    services: []
  }, { reviewRequired: true }).project;
  api.provider.renderProjectList();

  assert.equal(await api.provider.startProject(untrusted.id), false, 'An untrusted setup was allowed to start.');
  assert.equal(api.provider.mode, 'edit', 'A rejected untrusted start did not open review.');
  assert.equal(api.provider.selectedProjectId, untrusted.id, 'Review opened for the wrong project.');
  await api.provider.saveProject(api.provider.draft);
  assert.equal(
    api.provider.projects.find((project) => project.id === untrusted.id)?.reviewRequired,
    false,
    'Reviewing the complete setup did not approve it.'
  );

  assert.equal(api.provider.projects.length, 9, 'The setup phase did not retain every saved project.');
  const readyStarted = await api.provider.startProject(ready.id);
  assert.equal(readyStarted, true, `The setup host did not start the reload fixture: ${JSON.stringify({
    status: api.provider.getProjectStatus(ready.id),
    conflict: api.provider.projectPortConflicts.get(ready.id),
    output: api.provider.projectOutputs.get(ready.id)
  })}`);
  assert.equal(
    await api.provider.startProject(customStop.id),
    true,
    'The setup host did not start the custom Stop fixture.'
  );
  await waitFor(
    async () => {
      await api.provider.refreshProjectStatuses();
      return api.provider.getProjectStatus(ready.id) === 'running';
    },
    'The reload fixture never became ready before the extension host closed.',
    20000
  );
  assert.equal(
    fs.existsSync(path.join(smokeRoot, 'ready.pid')),
    true,
    'The reload fixture did not report its process id.'
  );
  await waitFor(
    () => fs.existsSync(path.join(smokeRoot, 'ready-child.pid'))
      && fs.existsSync(path.join(smokeRoot, 'ready-grandchild.pid')),
    'The reload fixture did not report its descendant process ids.'
  );
  await waitFor(
    () => fs.existsSync(customStopPidPath),
    'The custom Stop fixture did not report its process id.'
  );
  try {
    await waitFor(
      () => [ready.id, customStop.id].every((id) => (
        typeof api.provider.processOwnership.snapshot().get(id)?.childIdentity === 'string'
      )),
      'The setup host did not persist exact process identities.'
    );
  } catch {
    const ownership = [ready.id, customStop.id]
      .map((id) => api.provider.processOwnership.snapshot().get(id));
    const probes = await Promise.all(ownership.map(async (record) => {
      try {
        return await readRootProcess(record.childPid, process.platform);
      } catch (error) {
        return { error: error.message };
      }
    }));
    assert.fail(`The setup host did not persist exact process identities: ${JSON.stringify({ ownership, probes })}`);
  }
  const fixturePids = [
    path.join(smokeRoot, 'ready.pid'),
    readyChildPidPath,
    readyGrandchildPidPath,
    customStopPidPath
  ].map((pidPath) => Number(fs.readFileSync(pidPath, 'utf8')));
  const fixtureProcesses = await Promise.all(fixturePids.map(async (pid) => {
    const identity = (await readRootProcess(pid, process.platform))?.identity;
    assert.ok(identity, `The setup host could not capture fixture process identity for PID ${pid}.`);
    return { pid, identity };
  }));
  fs.writeFileSync(
    path.join(smokeRoot, 'fixture-identities.json'),
    JSON.stringify(fixtureProcesses)
  );
  const shutdownResults = await api.provider.dispose();
  await waitForExactProcessesStopped(
    fixtureProcesses,
    () => `Awaited extension shutdown left a smoke fixture process running: ${JSON.stringify({
      shutdownResults: shutdownResults.map((result) => result.status === 'rejected'
        ? { status: result.status, reason: result.reason?.message }
        : result)
    })}`
  );
  process.stdout.write('Smoke setup, isolated storage, view opening, untrusted review, and awaited reload shutdown passed.\n');
}

async function saveProject(provider, input) {
  fs.mkdirSync(input.folder, { recursive: true });
  await provider.showAddProject();
  await provider.saveProject(input);
  const project = provider.projects.find((candidate) => candidate.folder === input.folder);
  assert.ok(project, `Project ${input.name} was not saved through the provider.`);
  return project;
}

function projectFolder(workspacePath, name) {
  return path.join(workspacePath, name);
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

async function availableDistinctPort(usedPorts) {
  while (true) {
    const port = await availablePort();
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
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

async function exactProcessIsAlive(processRecord) {
  try {
    return (await readRootProcess(processRecord.pid, process.platform))?.identity
      === processRecord.identity;
  } catch {
    return false;
  }
}

async function waitForExactProcessesStopped(processes, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const fastDeadline = Math.min(deadline, Date.now() + 1000);
  while (Date.now() < fastDeadline) {
    if (processes.every((processRecord) => !processIsAlive(processRecord.pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if ((await Promise.all(processes.map(exactProcessIsAlive))).every((alive) => !alive)) {
    return;
  }
  while (Date.now() < deadline) {
    if (processes.every((processRecord) => !processIsAlive(processRecord.pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if ((await Promise.all(processes.map(exactProcessIsAlive))).every((alive) => !alive)) {
    return;
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

module.exports = { run };
