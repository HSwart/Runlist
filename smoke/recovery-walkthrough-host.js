const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const vscode = require('vscode');
const { upsertProject, upsertRunGroup } = require('../src/projects/project-store');
const { installAgentSkill } = require('../src/integrations/skill-installation');
const { WEBVIEW_HOST_COMPLETION_TIMEOUT_MS } = require('../scripts/webview-e2e-timeouts');

async function run() {
  const root = requiredEnvironment('RUNLIST_RECOVERY_WALKTHROUGH_ROOT');
  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  assert.ok(extension, 'The Runlist development extension was not installed.');
  const api = await extension.activate();
  assert.ok(api?.provider, 'The extension did not expose its guarded E2E API.');
  api.provider.statusMonitoringDisposable?.dispose();
  api.provider.statusMonitoringDisposable = undefined;
  fs.unwatchFile(api.projectsFile);

  const fixturePath = path.join(root, 'fixtures');
  const runningAPath = path.join(fixturePath, 'running-a');
  const runningBPath = path.join(fixturePath, 'running-b');
  const failedPath = path.join(fixturePath, 'failed-app');
  const reviewPath = path.join(fixturePath, 'review-app');
  for (const folder of [runningAPath, runningBPath, failedPath, reviewPath]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  writeIdleServer(runningAPath);
  writeIdleServer(runningBPath);
  writeIdleServer(failedPath);

  await vscode.commands.executeCommand('workbench.view.extension.runlist');
  await vscode.commands.executeCommand('runlist.projects.focus');
  await waitFor(() => Boolean(api.provider.view), 'The Runlist webview did not open.');

  fs.writeFileSync(path.join(root, 'host-ready.json'), JSON.stringify({
    fixturePath,
    failedPath,
    projectsFile: api.projectsFile,
    reviewPath,
    runningAPath,
    runningBPath,
    workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }));

  if (process.env.RUNLIST_RECOVERY_AUTO_SEED === '1') {
    await executeBrowserCommand({ action: 'seed-recovery-demo' }, api.provider, api, root);
    await executeBrowserCommand({ action: 'install-copilot-skill' }, api.provider, api, root);
    api.provider.agentConnections.cursor = {
      status: 'unavailable',
      message: 'Cursor skill install is not available in this demo environment.'
    };
    api.provider.render();
    process.stdout.write('Recovery visual demo seeded. VS Code is ready for manual walkthrough.\n');
    await serveBrowserCommands(root, api.provider, api);
    return;
  }

  await serveBrowserCommands(root, api.provider, api);
}

async function serveBrowserCommands(root, provider, api) {
  const completePath = path.join(root, 'browser-complete');
  const commandPath = path.join(root, 'browser-command.json');
  const responsePath = path.join(root, 'host-response.json');
  const deadline = Date.now() + (
    process.env.RUNLIST_RECOVERY_AUTO_SEED === '1'
      ? 24 * 60 * 60 * 1000
      : WEBVIEW_HOST_COMPLETION_TIMEOUT_MS
  );
  while (Date.now() < deadline) {
    if (fs.existsSync(completePath)) {
      return;
    }
    if (fs.existsSync(commandPath)) {
      const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
      fs.unlinkSync(commandPath);
      try {
        const result = await executeBrowserCommand(command, provider, api, root);
        fs.writeFileSync(responsePath, JSON.stringify({ id: command.id, result }));
      } catch (error) {
        fs.writeFileSync(responsePath, JSON.stringify({
          id: command.id,
          error: error.stack || error.message
        }));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('The recovery walkthrough driver did not complete.');
}

async function executeBrowserCommand(command, provider, api, root) {
  if (command.action === 'seed-recovery-demo') {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'host-ready.json'), 'utf8'));
    const portA = await availableDistinctPort(new Set());
    const portB = await availableDistinctPort(new Set([portA]));
    const runningA = upsertProject(provider.projectsFile, {
      name: 'API Service',
      folder: ready.runningAPath,
      startCommand: 'node server.js',
      stopCommand: '',
      services: [{ name: 'api', port: portA }]
    });
    const runningB = upsertProject(provider.projectsFile, {
      name: 'Web App',
      folder: ready.runningBPath,
      startCommand: 'node server.js',
      stopCommand: '',
      services: [{ name: 'web', port: portB }]
    });
    upsertProject(provider.projectsFile, {
      name: 'Legacy Import',
      folder: ready.reviewPath,
      startCommand: 'node server.js',
      stopCommand: '',
      services: []
    }, { reviewRequired: true });
    const failed = upsertProject(provider.projectsFile, {
      name: 'Broken App',
      folder: ready.failedPath,
      startCommand: 'node missing.js',
      stopCommand: '',
      services: []
    });
    const { group } = upsertRunGroup(provider.projectsFile, {
      name: 'Dev stack',
      projectIds: [runningA.project.id, runningB.project.id]
    });
    await provider.startProject(runningA.project.id);
    await provider.startProject(runningB.project.id);
    await waitFor(
      async () => {
        await provider.refreshProjectStatuses();
        return provider.getProjectStatus(runningA.project.id) === 'running'
          && provider.getProjectStatus(runningB.project.id) === 'running';
      },
      'Running projects did not start.',
      45000
    );
    provider.projectStatuses.set(failed.project.id, 'stopped');
    provider.projectFailureSummaries.set(failed.project.id, {
      title: 'Start failed',
      message: 'Cannot find module missing.js'
    });
    provider.projectOutputs.set(failed.project.id, 'Error: Cannot find module missing.js\n');
    provider.renderProjectList();
    return {
      groupId: group.id,
      groupName: group.name,
      failedProjectId: failed.project.id,
      runningProjectIds: [runningA.project.id, runningB.project.id]
    };
  }
  if (command.action === 'install-copilot-skill') {
    const extension = vscode.extensions.getExtension('hankoswart.runlist');
    const skillSource = path.join(extension.extensionPath, 'skills', 'runlist');
    installAgentSkill({
      agent: 'copilot',
      environment: process.env,
      platform: process.platform,
      sourceDirectory: skillSource
    });
    provider.agentConnections.copilot = {
      status: 'success',
      message: 'Runlist skill installed. Ask Copilot agent mode to set up projects.'
    };
    provider.render();
    return { copilotStatus: provider.agentConnections.copilot.status };
  }
  if (command.action === 'refresh-list') {
    provider.renderProjectList();
    return { refreshed: true };
  }
  if (command.action === 'begin-stop-group') {
    void provider.stopSavedRunGroup(command.groupId);
    return { triggered: true };
  }
  if (command.action === 'show-agent-setup') {
    provider.showAgentSetup();
    provider.render();
    return { mode: provider.mode };
  }
  if (command.action === 'show-terminal') {
    await provider.showProjectTerminal(command.projectId);
    return { shown: true };
  }
  if (command.action === 'begin-vscode-command') {
    void vscode.commands.executeCommand(command.command);
    return { command: command.command };
  }
  throw new Error(`Unsupported browser command: ${command.action}`);
}

function writeIdleServer(folder) {
  fs.writeFileSync(path.join(folder, 'server.js'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const marker = path.join(__dirname, 'starts.txt');",
    "fs.appendFileSync(marker, `${process.pid}\\n`);",
    'setInterval(() => undefined, 1000);',
    ''
  ].join('\n'));
}

function availableDistinctPort(usedPorts) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (usedPorts.has(port)) {
          resolve(availableDistinctPort(usedPorts));
          return;
        }
        usedPorts.add(port);
        resolve(port);
      });
    });
  });
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} was not provided to the extension host.`);
  return value;
}

module.exports = { run };
