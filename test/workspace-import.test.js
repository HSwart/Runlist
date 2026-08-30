const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildWorkspaceImportProposal } = require('../src/projects/workspace-import');

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
