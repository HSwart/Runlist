const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildWorkspaceImportProposal, consolidateChosenImportEntries } = require('../src/projects/workspace-import');

test('buildWorkspaceImportProposal aggregates workspace sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-workspace-import-'));
  fs.mkdirSync(path.join(root, 'packages', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'api', 'package.json'), JSON.stringify({
    name: 'api',
    scripts: { start: 'node index.js' }
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js' },
    workspaces: ['packages/*']
  }));
  fs.writeFileSync(path.join(root, 'Procfile'), 'web: npm run web\n');
  const proposal = buildWorkspaceImportProposal(root);
  assert.ok(proposal.entries.some((entry) => entry.source === 'package.json'));
  assert.ok(proposal.entries.some((entry) => entry.source === 'workspace package'));
  assert.ok(proposal.entries.some((entry) => entry.source === 'Procfile'));
});

test('consolidateChosenImportEntries keeps one project per folder before saving', () => {
  const root = '/workspace/app';
  const consolidated = consolidateChosenImportEntries([
    { kind: 'project', name: 'Start', folder: root, startCommand: 'npm start' },
    { kind: 'project', name: 'Dev', folder: root, startCommand: 'npm run dev' }
  ]);
  assert.equal(consolidated.entries.length, 1);
  assert.equal(consolidated.entries[0].name, 'Dev');
  assert.equal(consolidated.skipped.length, 1);
});

test('consolidateChosenImportEntries rejects compose and project for the same folder', () => {
  const root = '/workspace/app';
  assert.throws(
    () => consolidateChosenImportEntries([
      { kind: 'project', name: 'Dev', folder: root, startCommand: 'npm run dev' },
      { kind: 'compose', name: 'Compose', folder: root, startCommand: '', composeFiles: ['compose.yaml'] }
    ]),
    /Cannot import both Compose and separate projects/
  );
});
