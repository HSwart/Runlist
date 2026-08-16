const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { copyProjectPath, openProjectInNewWindow } = require('../project-navigation');

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
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(webview, /data-action="copy-project-path"[^>]*role="menuitem"[^>]*title="Copy the saved folder path for \$\{projectName\}"/);
  assert.match(webview, /<span>Copy project path<\/span>/);
  assert.match(webview, /'copy-project-path': \(\) => \{[\s\S]*type: 'copyProjectPath'/);
  assert.match(extension, /case 'copyProjectPath':[\s\S]*await this\.copyProjectPath\(message\.id\)/);
  assert.match(extension, /writeProjectPathToClipboard\(vscode, project\.folder\)/);
  assert.match(extension, /Copied \$\{project\.name\} path\./);
  assert.match(extension, /finally \{[\s\S]*this\.focusTarget = \{ type: 'project-menu', id \};[\s\S]*this\.renderProjectList\(\)/);
});
