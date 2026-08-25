const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const galleryFiles = [
  'media/gallery-01-hero.png',
  'media/gallery-02-status.png',
  'media/gallery-03-features.png'
];

function imageSources(markdown) {
  return [...markdown.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((match) => match[1]);
}

function firstFold(markdown) {
  const heading = markdown.indexOf('## A control panel');
  assert.ok(heading > 0, 'README must keep the control-panel section after the first fold');
  return markdown.slice(0, heading);
}

test('leads with Design gallery shots and four short product bullets', () => {
  const fold = firstFold(readme);
  const logo = fold.indexOf('media/runlist.png');
  const hero = fold.indexOf('media/gallery-01-hero.png');
  const bullets = fold.indexOf('- One sidebar for every local app.');
  const status = fold.indexOf('media/gallery-02-status.png');
  const features = fold.indexOf('media/gallery-03-features.png');

  assert.ok(logo >= 0 && logo < hero, 'logo stays above the hero shot');
  assert.ok(hero < bullets, 'hero comes before the four bullets');
  assert.ok(bullets < status, 'the four bullets come before the status shot');
  assert.ok(status < features, 'the features shot follows the status shot');
  assert.match(fold, /- One sidebar for every local app\.\n- Start and stop from the card\.\n- Ports you can act on\.\n- Run groups\.\n/);
  assert.equal((fold.match(/^- /gm) || []).length, 4);
  assert.doesNotMatch(fold, /runlist-preview\.png/);
});

test('ships the three gallery PNGs and keeps images on relative media/ paths', () => {
  const sources = imageSources(readme);

  assert.deepEqual(
    sources.filter((src) => src.startsWith('media/gallery-')),
    galleryFiles
  );
  for (const src of sources) {
    assert.match(src, /^media\/.+\.(png|svg)$/);
    assert.doesNotMatch(src, /^https?:/i);
    assert.doesNotMatch(src, /github\.com/i);
  }
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/(?:raw|blob)\//);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.ok(!sources.includes('media/runlist-preview.png'));
  assert.equal(require('../package.json').icon, 'media/runlist.png');

  for (const file of galleryFiles) {
    const image = fs.readFileSync(path.join(root, file));
    assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG', file);
    assert.ok(image.readUInt32BE(16) >= 800, `${file} width`);
    assert.ok(image.readUInt32BE(20) >= 400, `${file} height`);
  }
});

test('moves the Control and Agent tables under Reference', () => {
  const reference = readme.indexOf('\n## Reference\n');
  const controlTable = readme.indexOf('| Control | What it does |');
  const agentTable = readme.indexOf('| Agent | What to use |');
  const contributing = readme.indexOf('\n## Contributing\n');

  assert.ok(reference > 0);
  assert.ok(reference < controlTable);
  assert.ok(controlTable < agentTable);
  assert.ok(agentTable < contributing);
  assert.match(readme, /### Control\n/);
  assert.match(readme, /### Agent\n/);
  assert.match(readme, /\*\*GitHub Copilot\*\*.*\/runlist/s);
  assert.match(readme, /\*\*Codex\*\*.*\$runlist/s);
  assert.match(readme, /\*\*Claude Code\*\*.*\/runlist/s);
});

test('keeps README positioning and installation claims accurate', () => {
  assert.match(readme, /Runlist: Local Development Control Panel/);
  assert.match(readme, /Every local app, across every repository/);
  assert.match(readme, /Start, stop, monitor, and group dev servers, workers, and project commands/);
  assert.match(readme, /optionally let a supported coding agent propose the setup for your approval/);
  assert.match(readme, /asks before closing an external process to free one/);
  assert.match(readme, /revalidates each process identity before termination/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/releases\/download/);
  assert.match(readme, /Install from the VS Code Marketplace/);
  assert.match(readme, /marketplace\.visualstudio\.com\/items\?itemName=hankoswart\.runlist/);
  assert.match(
    readme,
    /Export one or all project setups.*import a file after a preview.*review and approve/is
  );
  assert.match(readme, /run groups.*saved order.*reverse/is);
  assert.match(readme, /repair proposal.*current.*proposed.*Retry start/is);
});
