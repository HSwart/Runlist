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

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} was not provided to the extension host.`);
  return value;
}

module.exports = { run };
