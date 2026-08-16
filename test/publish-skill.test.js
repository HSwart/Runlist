const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('repository publish skill uses only the guarded Marketplace command', () => {
  const manifest = require('../package.json');
  const skill = fs.readFileSync(path.join(root, '.agents', 'skills', 'publish-runlist', 'SKILL.md'), 'utf8');
  const metadata = fs.readFileSync(path.join(root, '.agents', 'skills', 'publish-runlist', 'agents', 'openai.yaml'), 'utf8');

  assert.match(skill, /^---\nname: publish-runlist\n/);
  assert.match(skill, /Microsoft Entra authentication/);
  assert.match(skill, /npm run publish:marketplace/);
  assert.match(skill, /Never request, create, store, or use a Personal Access Token/);
  assert.match(metadata, /Use \$publish-runlist/);
  assert.equal(
    manifest.scripts['publish:marketplace'],
    'npm run validate:marketplace:publish && npm run validate:marketplace:vsix && vsce publish --azure-credential --packagePath releases/runlist.vsix'
  );
});
