const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverComposeImportCandidate } = require('../src/compose/compose-file');

test('discovers compose files in the workspace root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');

  assert.deepEqual(discoverComposeImportCandidate(root), {
    folder: root,
    composeFiles: ['compose.yaml']
  });
});

test('returns multiple compose file names when both variants exist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-multi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  api:\n    image: node\n');

  assert.deepEqual(discoverComposeImportCandidate(root), {
    folder: root,
    composeFiles: ['compose.yaml', 'docker-compose.yml']
  });
});

test('returns undefined when no compose file exists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  assert.equal(discoverComposeImportCandidate(root), undefined);
});
