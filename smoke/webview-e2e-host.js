const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { upsertProject } = require('../src/projects/project-store');
const { WEBVIEW_HOST_COMPLETION_TIMEOUT_MS } = require('../scripts/webview-e2e-timeouts');

async function run() {
  const root = requiredEnvironment('RUNLIST_WEBVIEW_E2E_ROOT');
  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  assert.ok(extension, 'The Runlist development extension was not installed.');
  const api = await extension.activate();
  assert.ok(api?.provider, 'The extension did not expose its guarded E2E API.');
  api.provider.statusMonitoringDisposable?.dispose();
  api.provider.statusMonitoringDisposable = undefined;
  fs.unwatchFile(api.projectsFile);
  const warningResponses = [];
  vscode.window.showWarningMessage = async () => warningResponses.shift();
  api.provider.webviewE2eWarningResponses = warningResponses;

  const fixturePath = path.join(root, 'fixtures');
  const lifecyclePath = path.join(fixturePath, 'lifecycle-project');
  const importedPath = path.join(fixturePath, 'imported-project');
  fs.mkdirSync(lifecyclePath, { recursive: true });
  fs.mkdirSync(importedPath, { recursive: true });
  fs.writeFileSync(path.join(lifecyclePath, 'server.js'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const marker = path.join(__dirname, 'starts.txt');",
    "fs.appendFileSync(marker, `${process.pid}\\n`);",
    'setInterval(() => undefined, 1000);',
    ''
  ].join('\n'));

  await vscode.commands.executeCommand('workbench.view.extension.runlist');
  await vscode.commands.executeCommand('runlist.projects.focus');
  await waitFor(() => Boolean(api.provider.view), 'The Runlist webview did not open.');

  fs.writeFileSync(path.join(root, 'host-ready.json'), JSON.stringify({
    fixturePath,
    importedPath,
    lifecyclePath,
    projectsFile: api.projectsFile,
    workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }));
  await serveBrowserCommands(root, api.provider);
}

async function serveBrowserCommands(root, provider) {
  const completePath = path.join(root, 'browser-complete');
  const commandPath = path.join(root, 'browser-command.json');
  const responsePath = path.join(root, 'host-response.json');
  const deadline = Date.now() + WEBVIEW_HOST_COMPLETION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(completePath)) {
      assert.equal(provider.processes.size, 0, 'The browser suite left a Runlist process running.');
      return;
    }
    if (fs.existsSync(commandPath)) {
      const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
      fs.unlinkSync(commandPath);
      let result;
      try {
        result = await executeBrowserCommand(command, provider, root);
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
  assert.fail('The browser E2E driver did not complete.');
}

async function executeBrowserCommand(command, provider, root) {
  if (command.action === 'set-theme') {
    await vscode.workspace.getConfiguration('workbench').update(
      'colorTheme',
      command.theme,
      vscode.ConfigurationTarget.Global
    );
    return { theme: vscode.window.activeColorTheme.kind };
  }
  if (command.action === 'seed-review') {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'host-ready.json'), 'utf8'));
    const imported = upsertProject(provider.projectsFile, {
      name: 'Imported dashboard',
      folder: ready.importedPath,
      startCommand: 'node -e "setInterval(() => undefined, 1000)"',
      stopCommand: '',
      services: [],
      reviewRequired: true
    }, { reviewRequired: true });
    provider.renderProjectList();
    return { importedId: imported.project.id };
  }
  if (command.action === 'begin-vscode-command') {
    void vscode.commands.executeCommand(command.command);
    return { command: command.command };
  }
  if (command.action === 'refresh-list') {
    provider.renderProjectList();
    return { refreshed: true };
  }
  if (command.action === 'seed-running-screenshot') {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'host-ready.json'), 'utf8'));
    fs.writeFileSync(path.join(ready.lifecyclePath, 'server.js'), [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const path = require('node:path');",
      "const marker = path.join(__dirname, 'starts.txt');",
      "fs.appendFileSync(marker, `${process.pid}\\n`);",
      'http.createServer((request, response) => {',
      "  response.writeHead(200, { 'Content-Type': 'text/plain' });",
      "  response.end('ok');",
      '}).listen(4310, \'127.0.0.1\');',
      ''
    ].join('\n'));
    const seeded = upsertProject(provider.projectsFile, {
      name: 'Acme Storefront',
      folder: ready.lifecyclePath,
      startCommand: 'node server.js',
      stopCommand: '',
      services: [{ name: 'web', port: 4310 }]
    });
    provider.renderProjectList();
    const started = await provider.startProject(seeded.project.id);
    assert.equal(started, true, `Could not start the screenshot project (status=${provider.getProjectStatus(seeded.project.id)}).`);
    await waitFor(
      async () => {
        await provider.refreshProjectStatuses();
        return ['running', 'active'].includes(provider.getProjectStatus(seeded.project.id));
      },
      'Screenshot project did not become running after start.',
      20000
    );
    provider.renderProjectList();
    return {
      projectId: seeded.project.id,
      name: seeded.project.name,
      status: provider.getProjectStatus(seeded.project.id),
      hasProcess: provider.processes.has(seeded.project.id)
    };
  }
  if (command.action === 'seed-gallery-screenshot') {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'host-ready.json'), 'utf8'));
    const { upsertRunGroup } = require('../src/projects/project-store');
    const fixturePath = ready.fixturePath;
    const marketingPath = path.join(fixturePath, 'marketing-site');
    const adminPath = path.join(fixturePath, 'admin-dashboard');
    const analyticsPath = path.join(fixturePath, 'analytics-worker');
    const legacyPath = path.join(fixturePath, 'legacy-import');
    for (const folder of [
      ready.lifecyclePath,
      ready.importedPath,
      marketingPath,
      adminPath,
      analyticsPath,
      legacyPath
    ]) {
      fs.mkdirSync(folder, { recursive: true });
    }
    writeGalleryHttpServer(ready.lifecyclePath, [4310, 4312]);
    writeGalleryHttpServer(ready.importedPath, 4311);
    writeGalleryHttpServer(marketingPath, 4313);
    const storefront = upsertProject(provider.projectsFile, {
      name: 'Acme Storefront',
      folder: ready.lifecyclePath,
      startCommand: 'node server.js',
      stopCommand: '',
      pinned: true,
      services: [
        { name: 'web', port: 4310 },
        { name: 'api', port: 4312 }
      ]
    });
    const orders = upsertProject(provider.projectsFile, {
      name: 'Orders API',
      folder: ready.importedPath,
      startCommand: 'node server.js',
      stopCommand: '',
      services: [{ name: 'api', port: 4311 }]
    });
    const marketing = upsertProject(provider.projectsFile, {
      name: 'Marketing Site',
      folder: marketingPath,
      startCommand: 'node server.js',
      stopCommand: '',
      services: [{ name: 'web', port: 4313 }]
    });
    upsertProject(provider.projectsFile, {
      name: 'Admin Dashboard',
      folder: adminPath,
      startCommand: 'node -e "setInterval(() => undefined, 1000)"',
      stopCommand: '',
      services: [{ name: 'admin', port: 4314 }]
    });
    upsertProject(provider.projectsFile, {
      name: 'Analytics Worker',
      folder: analyticsPath,
      startCommand: 'node -e "setInterval(() => undefined, 1000)"',
      stopCommand: '',
      tags: ['backend'],
      services: [{ name: 'worker', port: 4315 }]
    });
    upsertProject(provider.projectsFile, {
      name: 'Legacy Import',
      folder: legacyPath,
      startCommand: 'node -e "setInterval(() => undefined, 1000)"',
      stopCommand: '',
      services: [{ name: 'legacy', port: 4316 }]
    }, { reviewRequired: true });
    upsertRunGroup(provider.projectsFile, {
      name: 'Development stack',
      projectIds: [storefront.project.id, orders.project.id, marketing.project.id],
      startMode: 'sequential'
    });
    provider.renderProjectList();
    const startedStorefront = await provider.startProject(storefront.project.id);
    assert.equal(startedStorefront, true, `Could not start Acme Storefront (status=${provider.getProjectStatus(storefront.project.id)}).`);
    const startedOrders = await provider.startProject(orders.project.id);
    assert.equal(startedOrders, true, `Could not start Orders API (status=${provider.getProjectStatus(orders.project.id)}).`);
    await waitFor(
      async () => {
        await provider.refreshProjectStatuses();
        return ['running', 'active'].includes(provider.getProjectStatus(storefront.project.id))
          && ['running', 'active'].includes(provider.getProjectStatus(orders.project.id));
      },
      'Screenshot projects did not become running after start.',
      25000
    );
    provider.renderProjectList();
    return {
      projectId: storefront.project.id,
      expandProjectName: storefront.project.name,
      projectIds: [storefront.project.id, orders.project.id],
      name: storefront.project.name,
      status: provider.getProjectStatus(storefront.project.id),
      hasProcess: provider.processes.has(storefront.project.id)
    };
  }
  if (command.action === 'expand-project-preview') {
    provider.toggleProjectPreview(command.projectId, command.focusAction || 'open-services');
    provider.renderProjectList();
    return { expanded: command.projectId };
  }
  if (command.action === 'project-status') {
    return {
      status: provider.getProjectStatus(command.projectId),
      hasProcess: provider.processes.has(command.projectId)
    };
  }
  if (command.action === 'stop-project') {
    await provider.stopProject(command.projectId);
    return { stopped: true };
  }
  if (command.action === 'prepare-screenshot') {
    await vscode.commands.executeCommand('runlist.projects.focus');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    return { prepared: true };
  }
  if (command.action === 'queue-warning-response') {
    provider.webviewE2eWarningResponses.push(command.response);
    return { queued: true };
  }
  if (command.action === 'start-count') {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'host-ready.json'), 'utf8'));
    const marker = path.join(ready.lifecyclePath, 'starts.txt');
    return fs.existsSync(marker)
      ? fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
      : 0;
  }
  throw new Error(`Unsupported browser command: ${command.action}`);
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

function writeGalleryHttpServer(folder, ports) {
  const normalizedPorts = Array.isArray(ports) ? ports : [ports];
  fs.writeFileSync(path.join(folder, 'server.js'), [
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    "const path = require('node:path');",
    "const marker = path.join(__dirname, 'starts.txt');",
    "fs.appendFileSync(marker, `${process.pid}\\n`);",
    'const handler = (request, response) => {',
    "  response.writeHead(200, { 'Content-Type': 'text/plain' });",
    "  response.end('ok');",
    '};',
    `for (const port of ${JSON.stringify(normalizedPorts)}) {`,
    "  http.createServer(handler).listen(port, '127.0.0.1');",
    '}',
    ''
  ].join('\n'));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} was not provided to the extension host.`);
  return value;
}

module.exports = { run };
