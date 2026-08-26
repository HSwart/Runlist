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
  assert.equal(
    manifest.description,
    'Start, stop, and switch local apps from one sidebar.'
  );
  assert.deepEqual(manifest.keywords.slice(0, 5), [
    'npm scripts',
    'task runner',
    'dev server',
    'process manager',
    'ports'
  ]);
  assert.ok(!manifest.keywords.slice(0, 5).includes('mcp'));
  assert.ok(!manifest.keywords.slice(0, 5).includes('coding agents'));
  assert.ok(!manifest.keywords.includes('project manager'));
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

test('leads the Marketplace release guide with terminal publish commands', () => {
  const releaseGuide = fs.readFileSync(path.join(root, 'docs', 'marketplace-release.md'), 'utf8');
  const terminalHeading = releaseGuide.indexOf('## Publish from the terminal');
  const publisherHeading = releaseGuide.indexOf('## Permanent publisher');

  assert.match(releaseGuide, /^# Marketplace release checklist\n\n## Publish from the terminal\n/);
  assert.ok(terminalHeading > 0 && terminalHeading < publisherHeading);
  assert.match(releaseGuide, /az login --allow-no-subscriptions/);
  assert.match(releaseGuide, /az account show/);
  assert.match(releaseGuide, /npm run publish:marketplace/);
  assert.match(releaseGuide, /vsce publish --azure-credential --packagePath releases\/runlist\.vsix/);
  assert.doesNotMatch(releaseGuide, /vsce publish -p\b/);
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

test('keeps Start and Stop unavailable in unsupported remote windows', () => {
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const manifest = require('../package.json');

  assert.equal(
    manifest.description,
    'Start, stop, and switch local apps from one sidebar.'
  );
  assert.match(webview, /lifecycleWindowSupported === false/);
  assert.match(webview, /Windows WSL network paths will not start or stop processes/);
  assert.doesNotMatch(webview, /Remote SSH, WSL, Dev Containers/);
});

test('documents GitHub Actions Marketplace publication from the marketplace environment', () => {
  const releaseGuide = fs.readFileSync(path.join(root, 'docs', 'marketplace-release.md'), 'utf8');
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'publish-marketplace.yml'),
    'utf8'
  );

  assert.match(releaseGuide, /Actions → \*\*Publish Marketplace\*\* → \*\*Run workflow\*\*/);
  assert.match(releaseGuide, /workflow_dispatch/);
  assert.match(releaseGuide, /only Ops publish path/);
  assert.match(releaseGuide, /not a second Ops route/);
  assert.match(releaseGuide, /optional Hanko fallback/i);
  assert.match(releaseGuide, /environment: marketplace/);
  assert.match(releaseGuide, /limited to protected branches/);
  assert.match(releaseGuide, /Publishing from a tag is not supported/);
  assert.doesNotMatch(releaseGuide, /Tag path|tag matching `v\*`|push a tag/);
  assert.doesNotMatch(releaseGuide, /That is the only publish path/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.doesNotMatch(workflow, /--azure-credential/);
  assert.doesNotMatch(workflow, /publish:marketplace/);
  assert.doesNotMatch(workflow, /ovsx|open-vsx|OVSX/i);
  assert.doesNotMatch(workflow, /-p\s| --pat\s/);
  assert.doesNotMatch(workflow, /echo\s+["']?\$\{?VSCE_PAT|printenv|printf\s+.*\$\{?VSCE_PAT/);
  assert.doesNotMatch(workflow, /tags:|refs\/tags|v\*/);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /environment:\s*marketplace/);
  assert.match(workflow, /VSCE_PAT:\s*\$\{\{\s*secrets\.VSCE_PAT\s*\}\}/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /vsce publish --packagePath releases\/runlist\.vsix/);
});

test('passes strict Marketplace publication validation', () => {
  const result = validateMarketplace(root);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
