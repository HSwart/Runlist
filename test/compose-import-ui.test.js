const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildComposeImportProposal } = require('../src/compose/compose-parse');
const { readProjects } = require('../src/projects/project-store');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const host = readShippedHostSource(root);
const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
const messageRouter = fs.readFileSync(path.join(root, 'media', 'message-router.js'), 'utf8');

test('Compose import review is read-only until save and never runs docker compose', () => {
  assert.match(webview, /function renderComposeImport\(/);
  assert.match(webview, /Review Compose import/);
  assert.match(webview, /data-action="approve-compose-import"/);
  assert.match(webview, /data-action="import-compose"[\s\S]*icon\('layers', 'menu-icon'\)/);
  assert.match(webview, /Runlist has not started Docker or Compose/);
  assert.match(styles, /\.compose-import-row \{/);
  assert.match(host, /async showComposeImport\(/);
  assert.match(host, /async importWorkspaceCompose\(/);
  assert.match(host, /async beginComposeImport\(/);
  assert.match(host, /async approveComposeImport\(/);
  assert.match(host, /buildComposeImportProposal\(/);
  assert.match(host, /composeImportServicesForSave\(/);
  const approve = host.slice(
    host.indexOf('async approveComposeImport()'),
    host.indexOf('async startThisFolder()')
  );
  assert.doesNotMatch(approve, /this\.loadProjects\s*\(/);
  assert.doesNotMatch(approve, /this\.projects\s*=/);
  assert.match(approve, /saved\.project/);
  assert.doesNotMatch(host, /spawn\(.*docker|execFile\(.*docker|docker compose up/);
  assert.match(router, /showComposeImport: \(message\) => host\.showComposeImport\(message\.id\)/);
  assert.match(router, /importWorkspaceCompose: \(\) => host\.importWorkspaceCompose\(\)/);
  assert.match(router, /approveComposeImport: \(\) => host\.approveComposeImport\(\)/);
  assert.match(messageRouter, /'showComposeImport'/);
  assert.match(messageRouter, /'importWorkspaceCompose'/);
  assert.match(messageRouter, /'approveComposeImport'/);
  assert.match(webview, /data-action="import-workspace-compose"/);
});

function loadRunlistProvider(messages) {
  const providerPath = path.join(root, 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage(message) {
        messages.push({ type: 'error', message });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message) {
        messages.push({ type: 'warning', message });
        return Promise.resolve(undefined);
      },
      showInformationMessage(message) {
        messages.push({ type: 'info', message });
        return Promise.resolve(undefined);
      }
    },
    workspace: { workspaceFolders: [] }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    providerModule._compile(source, providerPath);
    return providerModule.exports.RunlistViewProvider;
  } finally {
    Module._load = originalLoad;
  }
}

test('Compose import Save persists a quoted-port project without calling loadProjects', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-save-this-'));
  const folder = path.join(tempRoot, 'compose-str-ports');
  fs.mkdirSync(folder);
  const composePath = path.join(folder, 'compose.yaml');
  fs.writeFileSync(composePath, `
services:
  web:
    ports:
      - "4318:80"
`.trimStart());
  const projectsFile = path.join(tempRoot, 'projects.json');
  const messages = [];
  const Provider = loadRunlistProvider(messages);
  const provider = new Provider(
    { extensionUri: { fsPath: tempRoot } },
    projectsFile,
    path.join(tempRoot, 'mcp.js')
  );
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  provider.refreshProjectStatuses = async () => {};

  const proposal = buildComposeImportProposal({
    folder,
    composePath,
    contents: fs.readFileSync(composePath, 'utf8')
  });
  assert.equal(proposal.proposedProject.services[0].port, 4318);
  provider.mode = 'compose-import';
  provider.composeImport = {
    ...proposal,
    proposedProject: {
      ...proposal.proposedProject,
      services: [{ name: 'web', port: '4318', url: '' }]
    },
    existingProjectId: undefined
  };

  const saved = await provider.approveComposeImport();
  assert.equal(saved, true);
  assert.equal(provider.mode, 'list');
  assert.equal(provider.composeImport, undefined);
  assert.deepEqual(
    messages.filter((message) => message.type === 'error'),
    []
  );
  assert.match(
    messages.find((message) => message.type === 'info')?.message || '',
    /Added compose-str-ports from Compose/
  );

  const projects = readProjects(projectsFile);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'compose-str-ports');
  assert.equal(projects[0].services[0].port, 4318);
  assert.equal(typeof projects[0].services[0].port, 'number');
  assert.equal(provider.projects[0].id, projects[0].id);
  assert.equal(provider.focusTarget.id, projects[0].id);
});
