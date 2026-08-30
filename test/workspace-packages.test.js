const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverWorkspacePackageCandidates } = require('../src/projects/project-workspace');

test('discovers workspace packages with start or dev scripts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-workspace-packages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages', 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    workspaces: ['packages/*']
  }));
  fs.writeFileSync(path.join(root, 'packages', 'api', 'package.json'), JSON.stringify({
    name: '@acme/api',
    scripts: { dev: 'tsx src/index.ts' }
  }));
  fs.writeFileSync(path.join(root, 'packages', 'web', 'package.json'), JSON.stringify({
    name: '@acme/web',
    scripts: { start: 'vite preview' }
  }));

  assert.deepEqual(discoverWorkspacePackageCandidates(root), [
    {
      folder: path.join(root, 'packages', 'api'),
      name: '@acme/api',
      scriptName: 'dev',
      startCommand: 'npm run dev'
    },
    {
      folder: path.join(root, 'packages', 'web'),
      name: '@acme/web',
      scriptName: 'start',
      startCommand: 'npm start'
    }
  ]);
});

test('returns no workspace packages when the root has no workspaces field', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-workspace-packages-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite' }
  }));

  assert.deepEqual(discoverWorkspacePackageCandidates(root), []);
});
