const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  copyProjectPath,
  openProjectInNewWindow,
  openProjectTerminal,
  projectFolderIsAccessible
} = require('../src/webview/project-navigation');
const { readShippedHostSource } = require('./helpers/extension-source');

test('opens a saved project folder in a new VS Code window', async () => {
  const calls = [];
  const vscode = {
    commands: {
      executeCommand: async (...args) => {
        calls.push(args);
      }
    },
    Uri: {
      file: (folder) => ({ scheme: 'file', fsPath: folder })
    }
  };
  const folder = 'C:\\Users\\Example User\\Git Projects\\my-app';

  await openProjectInNewWindow(vscode, folder);

  assert.deepEqual(calls, [[
    'vscode.openFolder',
    { scheme: 'file', fsPath: folder },
    { forceNewWindow: true }
  ]]);
});

test('opens an integrated terminal in the exact saved folder without sending a command', () => {
  const terminals = [];
  const vscode = {
    window: {
      createTerminal: (options) => {
        const calls = { options, show: 0, sendText: 0 };
        terminals.push(calls);
        return {
          show: () => {
            calls.show += 1;
          },
          sendText: () => {
            calls.sendText += 1;
          }
        };
      }
    }
  };
  const folders = [
    'C:\\Users\\Example User\\Git Projects\\café app',
    '/Users/Example User/Git Projects/café app'
  ];

  for (const folder of folders) {
    openProjectTerminal(vscode, folder);
  }

  assert.deepEqual(terminals.map(({ options }) => options), folders.map((folder) => ({ cwd: folder })));
  assert.deepEqual(terminals.map(({ show }) => show), [1, 1]);
  assert.deepEqual(terminals.map(({ sendText }) => sendText), [0, 0]);
});

test('recognizes accessible directories and rejects missing or inaccessible folders', () => {
  const accessible = {
    constants: { R_OK: 4, X_OK: 1 },
    accessSync: () => {},
    statSync: () => ({ isDirectory: () => true })
  };
  const file = {
    ...accessible,
    statSync: () => ({ isDirectory: () => false })
  };
  const inaccessible = {
    ...accessible,
    accessSync: () => {
      throw new Error('access denied');
    }
  };

  assert.equal(projectFolderIsAccessible(accessible, '/projects/app'), true);
  assert.equal(projectFolderIsAccessible(file, '/projects/app'), false);
  assert.equal(projectFolderIsAccessible(inaccessible, '/projects/app'), false);
});

test('wires an accessible terminal action and restores or redirects focus after folder errors', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(webview, /data-action="open-terminal"[^>]*role="menuitem"[^>]*title="Open a terminal in \$\{projectName\}"/);
  assert.match(webview, /<span>Open terminal here<\/span>/);
  assert.match(webview, /'open-terminal': \(\) => \{[\s\S]*type: 'openProjectTerminal'/);
  assert.match(router, /openProjectTerminal: \(message\) => host\.openProjectTerminal\(message\.id\)/);
  assert.match(extension, /projectFolderIsAccessible\(fs, project\.folder\)[\s\S]*'Edit project'/);
  assert.match(extension, /selection === 'Edit project'[\s\S]*this\.showEditProject\(id\)/);
  assert.match(extension, /this\.focusTarget = \{ type: 'project-menu', id \};[\s\S]*this\.renderProjectList\(\)/);
});

test('copies exact persisted paths without normalization, quoting, or escaping', async () => {
  const copied = [];
  const vscode = {
    commands: {
      executeCommand: () => {
        throw new Error('Copying a path must not run a command.');
      }
    },
    env: {
      clipboard: {
        writeText: async (value) => {
          copied.push(value);
        }
      }
    }
  };
  const folders = [
    'C:\\Users\\Example User\\Git Projects\\café app',
    '\\\\server\\Shared Projects\\café app',
    '/Users/Example User/Git Projects/café app'
  ];

  for (const folder of folders) {
    await copyProjectPath(vscode, folder);
  }

  assert.deepEqual(copied, folders);
});

test('wires an accessible project-path action with confirmation and focus restoration', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const router = fs.readFileSync(path.join(root, 'src', 'webview', 'webview-message-router.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(webview, /data-action="copy-project-path"[^>]*role="menuitem"[^>]*title="Copy the saved folder path for \$\{projectName\}"/);
  assert.match(webview, /<span>Copy project path<\/span>/);
  assert.match(webview, /'copy-project-path': \(\) => \{[\s\S]*type: 'copyProjectPath'/);
  assert.match(router, /copyProjectPath: \(message\) => host\.copyProjectPath\(message\.id\)/);
  assert.match(extension, /writeProjectPathToClipboard\(vscode, project\.folder\)/);
  assert.match(extension, /Copied \$\{project\.name\} path\./);
  assert.match(extension, /finally \{[\s\S]*this\.focusTarget = \{ type: 'project-menu', id \};[\s\S]*this\.renderProjectList\(\)/);
});
