const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  discoverProcfileProcessCandidates,
  parseProcfileContents
} = require('../src/projects/workspace-import');

test('parseProcfileContents reads process names and commands', () => {
  assert.deepEqual(parseProcfileContents(`
# comment
web: npm start
api: cd api && npm run dev

release: npm run build
`), [
    { name: 'web', startCommand: 'npm start' },
    { name: 'api', startCommand: 'cd api && npm run dev' },
    { name: 'release', startCommand: 'npm run build' }
  ]);
});

test('prefers Procfile.dev over Procfile for duplicate process names', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-procfile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Procfile.dev'), `
web: npm run dev
worker: node worker.js
`.trimStart());
  fs.writeFileSync(path.join(root, 'Procfile'), `
web: npm start
release: npm run build
`.trimStart());

  assert.deepEqual(discoverProcfileProcessCandidates(root), [
    {
      folder: root,
      name: 'release',
      startCommand: 'npm run build',
      sourceFile: 'Procfile'
    },
    {
      folder: root,
      name: 'web',
      startCommand: 'npm run dev',
      sourceFile: 'Procfile.dev'
    },
    {
      folder: root,
      name: 'worker',
      startCommand: 'node worker.js',
      sourceFile: 'Procfile.dev'
    }
  ]);
});

test('returns no procfile candidates when no Procfile exists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-procfile-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  assert.deepEqual(discoverProcfileProcessCandidates(root), []);
});
