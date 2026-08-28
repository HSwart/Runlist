const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('enforces focused static analysis, critical coverage, SBOM, and package identity gates', () => {
  const manifest = require('../package.json');
  const coverage = fs.readFileSync(path.join(root, 'scripts', 'test-critical-coverage.js'), 'utf8');
  const sbom = fs.readFileSync(path.join(root, 'scripts', 'validate-sbom.js'), 'utf8');

  assert.equal(manifest.scripts.lint, 'eslint . --max-warnings=0');
  assert.match(manifest.scripts.quality, /npm run lint/);
  assert.match(manifest.scripts.quality, /npm run scan:secrets/);
  assert.match(manifest.scripts.quality, /npm run test:critical-coverage/);
  assert.match(manifest.scripts.quality, /npm run validate:sbom/);
  assert.match(manifest.scripts.quality, /npm run validate:marketplace:vsix/);
  assert.match(coverage, /--test-coverage-branches=80/);
  assert.match(coverage, /src\/lifecycle\/project-process\.js/);
  assert.match(coverage, /src\/ports\/port-gate\.js/);
  assert.match(coverage, /src\/projects\/project-store\.js/);
  assert.match(sbom, /--sbom-format=cyclonedx/);
  assert.match(sbom, /pkg:npm\/\$\{manifest\.name\}@\$\{manifest\.version\}/);
});

test('runs pinned secret scanning and SBOM gates without duplicating CodeQL default setup', () => {
  const testWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8');
  const securityWorkflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'security.yml'),
    'utf8'
  );
  const publishWorkflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'publish-marketplace.yml'),
    'utf8'
  );
  const unpinnedAction = /uses:\s+[^\s@]+@(?![a-f0-9]{40}(?:\s|$))/i;

  assert.match(testWorkflow, /name: Engineering gates[\s\S]*npm run quality/);
  assert.match(testWorkflow, /name: Upload release SBOM/);
  assert.doesNotMatch(testWorkflow, unpinnedAction);
  assert.doesNotMatch(securityWorkflow, /github\/codeql-action/);
  assert.match(securityWorkflow, /name: Secret scan/);
  assert.match(securityWorkflow, /run: npm run scan:secrets/);
  assert.doesNotMatch(securityWorkflow, unpinnedAction);
  assert.match(publishWorkflow, /environment:\s*marketplace/);
  assert.doesNotMatch(publishWorkflow, unpinnedAction);
});

test('rejects fork and non-allowed pull request authors with a same-repo authors check', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'same-repo-authors.yml'),
    'utf8'
  );
  const unpinnedAction = /uses:\s+[^\s@]+@(?![a-f0-9]{40}(?:\s|$))/i;

  assert.match(workflow, /^name: Same-repo authors only$/m);
  assert.match(workflow, /^\s+name: Same-repo authors only$/m);
  assert.match(workflow, /on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[opened, synchronize, reopened, ready_for_review\]/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(workflow, /github\.repository/);
  assert.match(workflow, /github\.event\.pull_request\.user\.login/);
  assert.match(workflow, /HSwart\|'cursor\[bot\]'/);
  assert.match(workflow, /Fork pull request rejected/);
  assert.match(workflow, /Wrong author rejected/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /actions\/setup-node/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /npm /);
  assert.doesNotMatch(workflow, unpinnedAction);
});

test('detects high-confidence secrets without reproducing their values', () => {
  const { detectSecrets } = require('../scripts/scan-secrets');
  const githubToken = 'ghp_' + 'a'.repeat(36);
  const privateKey = ['-----BEGIN RSA', ' PRIVATE KEY-----'].join('');

  assert.deepEqual(detectSecrets(`${githubToken}\n${privateKey}`), [
    'private-key',
    'github-token'
  ]);
  assert.deepEqual(detectSecrets('TOKEN=example-value'), []);
});
