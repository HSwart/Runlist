const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canUseCurrentWorkspace,
  localWorkspaceFolders,
  selectCurrentWorkspaceFolder
} = require('../project-workspace');

function workspaceFolder(name, fsPath, scheme = 'file') {
  return { name, uri: { fsPath, scheme } };
}

test('offers the current workspace action only when a local folder is open', () => {
  assert.equal(canUseCurrentWorkspace(undefined), false);
  assert.equal(canUseCurrentWorkspace([]), false);
  assert.equal(canUseCurrentWorkspace([
    workspaceFolder('Remote app', '/workspaces/app', 'vscode-remote')
  ]), false);
  assert.equal(canUseCurrentWorkspace([
    workspaceFolder('Local app', '/Users/example/Local app')
  ]), true);
});

test('filters workspace roots to usable local folders', () => {
  const localFolder = workspaceFolder('Local app', '/Users/example/Local app');
  assert.deepEqual(localWorkspaceFolders([
    localFolder,
    workspaceFolder('Remote app', '/workspaces/app', 'vscode-remote'),
    { name: 'Missing URI' }
  ]), [localFolder]);
});

test('uses the only local workspace folder directly and preserves its platform path', async () => {
  let quickPickCalls = 0;
  const vscode = {
    workspace: {
      workspaceFolders: [workspaceFolder(
        'Windows app',
        'C:\\Users\\Example User\\Git Projects\\my-app'
      )]
    },
    window: {
      showQuickPick: async () => {
        quickPickCalls += 1;
      }
    }
  };

  assert.equal(
    await selectCurrentWorkspaceFolder(vscode),
    'C:\\Users\\Example User\\Git Projects\\my-app'
  );
  assert.equal(quickPickCalls, 0);
});

test('asks the user to choose from clearly labeled multi-root workspace folders', async () => {
  const workspaceFolders = [
    workspaceFolder('Frontend', '/Users/example/product/frontend'),
    workspaceFolder('API', '/Users/example/product/api')
  ];
  let pickerItems;
  let pickerOptions;
  const vscode = {
    workspace: { workspaceFolders },
    window: {
      showQuickPick: async (items, options) => {
        pickerItems = items;
        pickerOptions = options;
        return items[1];
      }
    }
  };

  assert.equal(await selectCurrentWorkspaceFolder(vscode), '/Users/example/product/api');
  assert.deepEqual(pickerItems, [
    {
      description: '/Users/example/product/frontend',
      folder: '/Users/example/product/frontend',
      label: 'Frontend'
    },
    {
      description: '/Users/example/product/api',
      folder: '/Users/example/product/api',
      label: 'API'
    }
  ]);
  assert.deepEqual(pickerOptions, {
    matchOnDescription: true,
    placeHolder: 'Choose the workspace folder to use for this project',
    title: 'Use current workspace'
  });
});

test('returns no folder when none is open or a multi-root choice is cancelled', async () => {
  const emptyVscode = {
    workspace: {},
    window: { showQuickPick: async () => assert.fail('picker should not open') }
  };
  assert.equal(await selectCurrentWorkspaceFolder(emptyVscode), undefined);

  const multiRootVscode = {
    workspace: {
      workspaceFolders: [
        workspaceFolder('One', '/workspace/one'),
        workspaceFolder('Two', '/workspace/two')
      ]
    },
    window: { showQuickPick: async () => undefined }
  };
  assert.equal(await selectCurrentWorkspaceFolder(multiRootVscode), undefined);
});
