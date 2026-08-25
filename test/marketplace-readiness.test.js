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
  assert.equal(manifest.displayName, 'Runlist: Local Development Control Panel');
  assert.equal(
    manifest.description,
    'Start, stop, monitor, and group local apps on the same computer as this VS Code window.'
  );
  assert.deepEqual(manifest.keywords.slice(0, 4), [
    'npm scripts',
    'task runner',
    'dev server',
    'process manager'
  ]);
  assert.ok(manifest.keywords.includes('dev server'));
  assert.ok(manifest.keywords.includes('process manager'));
  assert.ok(manifest.keywords.includes('npm scripts'));
  assert.ok(!manifest.keywords.includes('project manager'));
  assert.deepEqual(manifest.categories, ['Other']);
  assert.equal(manifest.publisher, 'hankoswart');
  assert.equal(manifest.repository.url, 'https://github.com/HSwart/Runlist.git');
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
    'src/host/runlist-view-provider.js',
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

test('documents temporary candidate validation and tracked publication artifact', () => {
  const releaseGuide = fs.readFileSync(path.join(root, 'docs', 'marketplace-release.md'), 'utf8');

  assert.match(releaseGuide, /temporary candidate from (?:the )?current source/i);
  assert.match(releaseGuide, /compares the candidate's .* with the tracked artifact/i);
  assert.match(releaseGuide, /publishes the tracked `releases\/runlist\.vsix` artifact/i);
  assert.doesNotMatch(releaseGuide, /does not repackage the source/i);
});

test('requires extension-host smoke with the supported CI session commands', () => {
  const releaseGuide = fs.readFileSync(path.join(root, 'docs', 'marketplace-release.md'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8');

  assert.match(releaseGuide, /On Windows and macOS, run `npm run test:smoke` in a supported native desktop session\./i);
  assert.match(releaseGuide, /On Linux, run `xvfb-run -a npm run test:smoke` with an Xvfb display\./i);
  assert.match(releaseGuide, /passes only when the command exits successfully and reports `Runlist extension-host smoke suite passed\.`/i);
  assert.match(workflow, /fail-fast:\s*false/);
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-latest\]/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.equal((workflow.match(/timeout-minutes:\s*20/g) || []).length, 2);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test('names where Start and Stop work before Local lifecycle only', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const manifest = require('../package.json');

  assert.match(manifest.description, /same computer as this VS Code window/i);
  assert.match(readme, /same computer/i);
  assert.match(readme, /Remote - WSL/);
  assert.match(readme, /Remote SSH/);
  assert.match(readme, /Dev Containers/);
  assert.match(readme, /Codespaces/);
  assert.match(readme, /Tunnels/);
  assert.match(readme, /WSL network path/);
  assert.match(webview, /lifecycleWindowSupported === false/);
  assert.match(webview, /Windows WSL network paths will not start or stop processes/);
  assert.doesNotMatch(webview, /Remote SSH, WSL, Dev Containers/);
});

test('passes strict Marketplace publication validation', () => {
  const result = validateMarketplace(root);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
