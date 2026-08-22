const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateMarketplace } = require('../scripts/validate-marketplace');

const root = path.join(__dirname, '..');

test('validates Marketplace metadata for the selected publisher and release', () => {
  const manifest = require('../package.json');
  const result = validateMarketplace(root, { preparation: true });

  assert.equal(manifest.name, 'runlist');
  assert.equal(manifest.displayName, 'Runlist');
  assert.equal(manifest.publisher, 'hankoswart');
  assert.equal(manifest.repository.url, 'https://github.com/HSwart/Runlist.git');
  assert.equal(manifest.keywords.includes('project manager'), false);
  assert.equal(manifest.keywords.includes('process control'), true);
  assert.equal(
    manifest.scripts['publish:marketplace'],
    'npm run validate:marketplace:publish && npm run validate:marketplace:vsix && vsce publish --azure-credential --packagePath releases/runlist.vsix'
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('does not ship stale product branding', () => {
  const shippedTextFiles = [
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'src/integrations/agent-registration.js',
    'extension.js',
    'mcp/server.js',
    'media/main.js',
    'media/runlist-readme.svg',
    'package.json',
    'src/projects/project-diagnostics.js',
    'src/projects/project-output.js',
    'src/lifecycle/project-process.js',
    'src/projects/project-store.js',
    'src/ports/service-port-overrides.js',
    'src/integrations/skill-installation.js',
    'skills/runlist/SKILL.md',
    'skills/runlist/agents/openai.yaml'
  ];

  for (const file of shippedTextFiles) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(contents, /\bswitchboard\b/i, file);
    assert.doesNotMatch(contents, /\bporter\b/i, file);
  }
});

test('passes strict Marketplace publication validation', () => {
  const result = validateMarketplace(root);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
