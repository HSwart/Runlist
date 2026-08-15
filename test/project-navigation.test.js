const test = require('node:test');
const assert = require('node:assert/strict');
const { openProjectInNewWindow } = require('../project-navigation');

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
