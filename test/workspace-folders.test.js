const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canUseCurrentWorkspace,
  chooseCurrentWorkspaceFolder,
  hasLocalWorkspaceFolder,
  localWorkspaceFolders
} = require('../workspace-folders');

function workspaceFolder(name, fsPath, scheme = 'file') {
  return { name, uri: { fsPath, scheme } };
}

test('uses the only local workspace folder without opening a picker', async () => {
  const folder = workspaceFolder('my-app', 'C:\\Users\\Example User\\my-app');
  let pickerShown = false;
  const vscode = {
    window: {
      showQuickPick: async () => {
        pickerShown = true;
      }
    },
    workspace: { workspaceFolders: [folder] }
  };

  assert.equal(await chooseCurrentWorkspaceFolder(vscode), folder.uri.fsPath);
  assert.equal(pickerShown, false);
});

test('returns no choice when no local workspace folder is open', async () => {
  const remoteFolder = workspaceFolder('remote', '/workspaces/remote', 'vscode-remote');
  const vscode = {
    window: { showQuickPick: async () => assert.fail('picker should not open') },
    workspace: { workspaceFolders: [remoteFolder] }
  };

  assert.equal(await chooseCurrentWorkspaceFolder(vscode), undefined);
  assert.equal(hasLocalWorkspaceFolder(undefined), false);
  assert.deepEqual(localWorkspaceFolders([remoteFolder]), []);
  assert.equal(canUseCurrentWorkspace('add', [remoteFolder]), false);
});

test('shows the shortcut only while adding a project with a local folder open', () => {
  const folders = [workspaceFolder('project', '/home/example/project')];

  assert.equal(canUseCurrentWorkspace('add', folders), true);
  assert.equal(canUseCurrentWorkspace('edit', folders), false);
  assert.equal(canUseCurrentWorkspace('list', folders), false);
});

test('lets the user choose among multiple local workspace folders', async () => {
  const folders = [
    workspaceFolder('client', '/Users/example/work/client'),
    workspaceFolder('server', '/Users/example/work/server')
  ];
  let options;
  let pickerOptions;
  const vscode = {
    window: {
      showQuickPick: async (items, settings) => {
        options = items;
        pickerOptions = settings;
        return items[1];
      }
    },
    workspace: { workspaceFolders: folders }
  };

  assert.equal(await chooseCurrentWorkspaceFolder(vscode), folders[1].uri.fsPath);
  assert.deepEqual(options.map(({ label, description }) => ({ label, description })), [
    { label: 'client', description: '/Users/example/work/client' },
    { label: 'server', description: '/Users/example/work/server' }
  ]);
  assert.equal(pickerOptions.placeHolder, 'Choose a workspace folder to use');
  assert.equal(pickerOptions.matchOnDescription, true);
});

test('returns no choice when the multi-root picker is cancelled', async () => {
  const folders = [
    workspaceFolder('first', '/home/example/first'),
    workspaceFolder('second', '/home/example/second')
  ];
  const vscode = {
    window: { showQuickPick: async () => undefined },
    workspace: { workspaceFolders: folders }
  };

  assert.equal(await chooseCurrentWorkspaceFolder(vscode), undefined);
});
