const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  releaseNotesForCurrentVersion,
  releaseNotesFromChangelog
} = require('../scripts/release-notes');

const root = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

test('builds GitHub release notes from the manifest version changelog section', () => {
  const notes = releaseNotesForCurrentVersion(root);
  assert.match(notes, /## Terminal output alignment/);
  assert.match(notes, /left-aligned like a normal terminal/);
  assert.match(notes, /download `runlist\.vsix` from this release/);
  assert.match(notes, /Publish Marketplace/);
});

test('rejects missing changelog sections for a release version', () => {
  assert.throws(
    () => releaseNotesFromChangelog(changelog, '9.9.9'),
    /CHANGELOG\.md does not include a section for 9\.9\.9/
  );
});

test('documents the GitHub release workflow on main', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'publish-github-release.yml'),
    'utf8'
  );
  const unpinnedAction = /uses:\s+[^\s@]+@(?![a-f0-9]{40}(?:\s|$))/i;

  assert.match(workflow, /name: Publish GitHub Release/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /node scripts\/release-notes\.js/);
  assert.match(workflow, /releases\/runlist\.vsix/);
  assert.doesNotMatch(workflow, unpinnedAction);
});
