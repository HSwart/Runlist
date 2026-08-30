const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const extension = readShippedHostSource();
const providerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
  'utf8'
);
const entrySource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

test('palette commands that need the sidebar reveal Runlist when it is not open yet', () => {
  const revealStart = extension.indexOf('async revealRunlistView()');
  const addStart = extension.indexOf('async showAddProject(returnFocus)');
  const agentsStart = extension.indexOf('async showAgentSetup()');
  const addEnd = extension.indexOf('async showProjectTransfer()');

  assert.ok(revealStart !== -1);
  assert.ok(addStart > revealStart);
  assert.ok(agentsStart > addStart);
  assert.ok(addEnd > agentsStart);

  const reveal = extension.slice(revealStart, addStart);
  const addAndAgents = extension.slice(addStart, addEnd);

  assert.match(reveal, /workbench\.view\.extension\.runlist/);
  assert.match(reveal, /runlist\.projects\.focus/);
  assert.match(addAndAgents, /await this\.revealRunlistView\(\)/);
  assert.equal((addAndAgents.match(/await this\.revealRunlistView\(\)/g) || []).length, 7);
  assert.doesNotMatch(addAndAgents, /this\.view\?\.show\?\.\(true\)/);
});

test('Add This Folder prefills the open workspace folder and focuses the remaining required field', () => {
  const addStart = extension.indexOf('async showAddProject(returnFocus)');
  const addEnd = extension.indexOf('async showAgentSetup()');
  const addProject = extension.slice(addStart, addEnd);

  assert.match(addProject, /starterDraftForCurrentWorkspace\(vscode\.workspace\.workspaceFolders, this\.preferredWorkspaceFolder\)/);
  assert.match(addProject, /id: 'start-command'/);
  assert.match(addProject, /id: 'folder'/);
});

test('sidebar state marks and sorts the This-window project', () => {
  assert.match(extension, /currentWorkspace: workspaceFolderMatchesProject\(/);
  assert.match(extension, /orderSidebarProjects\(projects\.map/);
  assert.match(extension, /currentWorkspaceFolder: this\.workspaceRoot\(\)/);
});

test('workspace-folder changes rerender This window and Add this folder from the provider', () => {
  assert.match(
    providerSource,
    /workspaceFoldersDisposable = vscode\.workspace\?\.onDidChangeWorkspaceFolders\?\.\(\(\) => \{[\s\S]*this\.render\(\);[\s\S]*\}\)/
  );
  assert.match(providerSource, /workspaceFoldersDisposable\?\.dispose\(\)/);
  assert.doesNotMatch(entrySource, /onDidChangeWorkspaceFolders/);
});

test('workspace-folder listener rerenders and is disposed with the provider', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-workspace-folders-'));
  const projectsFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  let folderListener;
  let disposed = false;
  const vscode = {
    env: { remoteName: undefined },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
    },
    window: {
      showErrorMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined)
    },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders(listener) {
        folderListener = listener;
        return {
          dispose() {
            disposed = true;
            folderListener = undefined;
          }
        };
      }
    }
  };
  const providerPath = path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js');
  const source = fs.readFileSync(providerPath, 'utf8');
  const providerModule = new Module(providerPath, module);
  providerModule.filename = providerPath;
  providerModule.paths = Module._nodeModulePaths(path.dirname(providerPath));
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let Provider;
  try {
    providerModule._compile(source, providerPath);
    Provider = providerModule.exports.RunlistViewProvider;
  } finally {
    Module._load = originalLoad;
  }

  const provider = new Provider(
    { extensionUri: { fsPath: root } },
    projectsFile,
    path.join(root, 'mcp.js')
  );
  const renders = [];
  provider.render = () => {
    renders.push('render');
  };
  t.after(async () => {
    await provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(typeof folderListener, 'function');
  folderListener();
  assert.deepEqual(renders, ['render']);

  await provider.dispose();
  assert.equal(disposed, true);
  assert.equal(folderListener, undefined);
});

test('Start This Folder reveals the sidebar and starts from the project card', () => {
  const start = extension.indexOf('async startThisFolder()');
  const end = extension.indexOf('async showProjectTransfer()');
  const method = extension.slice(start, end);

  assert.match(method, /startThisFolderDecision\(/);
  assert.match(method, /confirmDiscardProjectChanges\(\)/);
  assert.match(method, /showWarningMessage\(decision\.message\)/);
  assert.match(method, /this\.mode = 'list'/);
  assert.match(method, /await this\.revealRunlistView\(\)/);
  assert.match(method, /type: 'project-control'/);
  assert.match(method, /return this\.startProject\(decision\.projectId\)/);
  assert.doesNotMatch(method, /startProjectProcess/);
  assert.match(extension, /registerCommand\('runlist\.startThisFolder'/);
});
