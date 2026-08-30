const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverVscodeTaskCandidates } = require('../src/projects/vscode-tasks-discovery');

test('discovers npm start and dev tasks from .vscode/tasks.json', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vscode-tasks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vscode', 'tasks.json'), JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'Web dev', type: 'npm', script: 'dev', path: 'packages/web' },
      { label: 'Root start', type: 'npm', script: 'start' },
      { label: 'Build', type: 'npm', script: 'build' },
      { label: 'Shell dev', type: 'shell', command: 'npm run dev' }
    ]
  }));

  assert.deepEqual(discoverVscodeTaskCandidates(root), [
    {
      folder: root,
      name: 'Root start',
      scriptName: 'start',
      startCommand: 'npm start'
    },
    {
      folder: path.join(root, 'packages', 'web'),
      name: 'Web dev',
      scriptName: 'dev',
      startCommand: 'npm run dev'
    }
  ]);
});

test('returns no vscode task candidates when tasks.json is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vscode-tasks-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(discoverVscodeTaskCandidates(root), []);
});
