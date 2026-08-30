const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vscode = require('vscode');
const { upsertProject, upsertRunGroup } = require('../src/projects/project-store');
const { installAgentSkill } = require('../src/integrations/skill-installation');

async function seedRecoveryVisualDemo(provider, api) {
  const root = process.env.RUNLIST_RECOVERY_WALKTHROUGH_ROOT;
  if (!root) {
    return;
  }
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
  await waitFor(() => Boolean(provider.view), 'The Runlist webview did not open.', 15000);

  const portA = await availableDistinctPort(new Set());
  const portB = await availableDistinctPort(new Set([portA]));
  const runningA = upsertProject(provider.projectsFile, {
    name: 'API Service',
    folder: runningAPath,
    startCommand: `${process.execPath} server.js`,
    stopCommand: '',
    services: [{ name: 'api', port: portA }]
  });
  const runningB = upsertProject(provider.projectsFile, {
    name: 'Web App',
    folder: runningBPath,
    startCommand: `${process.execPath} server.js`,
    stopCommand: '',
    services: [{ name: 'web', port: portB }]
  });
  upsertProject(provider.projectsFile, {
    name: 'Legacy Import',
    folder: reviewPath,
    startCommand: `${process.execPath} server.js`,
    stopCommand: '',
    services: []
  }, { reviewRequired: true });
  const failed = upsertProject(provider.projectsFile, {
    name: 'Broken App',
    folder: failedPath,
    startCommand: `${process.execPath} missing.js`,
    stopCommand: '',
    services: []
  });
  upsertRunGroup(provider.projectsFile, {
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
    60000
  );

  provider.projectStatuses.set(failed.project.id, 'stopped');
  provider.projectFailureSummaries.set(failed.project.id, {
    title: 'Start failed',
    message: 'Cannot find module missing.js'
  });
  provider.projectOutputs.set(failed.project.id, 'Error: Cannot find module missing.js\n');
  provider.renderProjectList();

  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  installAgentSkill({
    agent: 'copilot',
    environment: process.env,
    platform: process.platform,
    sourceDirectory: path.join(extension.extensionPath, 'skills', 'runlist')
  });
  provider.agentConnections.copilot = {
    status: 'success',
    message: 'Runlist skill installed. Ask Copilot agent mode to set up projects.'
  };
  provider.agentConnections.cursor = {
    status: 'unavailable',
    message: 'Cursor skill install is not available in this demo environment.'
  };
  provider.render();
  process.stdout.write('Recovery visual demo seeded with real running projects.\n');
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

module.exports = { seedRecoveryVisualDemo };
