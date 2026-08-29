'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('closes automation issues when an automation pull request merges', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'automation-close-issue.yml'),
    'utf8'
  );
  const unpinnedAction = /uses:\s+[^\s@]+@(?![a-f0-9]{40}(?:\s|$))/i;

  assert.match(workflow, /^name: Automation issue lifecycle$/m);
  assert.match(workflow, /types:\s*\[closed\]/);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/);
  assert.match(workflow, /startsWith\(github\.event\.pull_request\.head\.ref, 'automation\/'\)/);
  assert.match(workflow, /permissions:\s*\n\s+issues: write/);
  assert.match(workflow, /sed -n 's\|\^automation\//);
  assert.match(workflow, /\[0-9\]\[0-9\]\*/);
  assert.match(workflow, /gh issue close/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, unpinnedAction);
});

test('auto-merges green automation pull requests', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'automation-auto-merge.yml'),
    'utf8'
  );
  const unpinnedAction = /uses:\s+[^\s@]+@(?![a-f0-9]{40}(?:\s|$))/i;

  assert.match(workflow, /^name: Automation auto-merge$/m);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /- Test/);
  assert.match(workflow, /- Same-repo authors only/);
  assert.match(workflow, /- Security/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /automation\//);
  assert.match(workflow, /gh pr ready/);
  assert.match(workflow, /gh pr merge/);
  assert.match(workflow, /--squash --delete-branch/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, unpinnedAction);
});
