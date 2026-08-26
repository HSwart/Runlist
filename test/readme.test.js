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
  const heading = markdown.indexOf('## Install');
  assert.ok(heading > 0, 'README must keep Install after the first fold');
  return markdown.slice(0, heading);
}

test('leads with the logo, three gallery shots, and short captions', () => {
  const fold = firstFold(readme);
  const logo = fold.indexOf('media/runlist.png');
  const hero = fold.indexOf('media/gallery-01-hero.png');
  const status = fold.indexOf('media/gallery-02-status.png');
  const features = fold.indexOf('media/gallery-03-features.png');

  assert.ok(logo >= 0 && logo < hero, 'logo stays above the hero shot');
  assert.ok(hero < status, 'hero comes before the status shot');
  assert.ok(status < features, 'the features shot follows the status shot');
  assert.match(fold, /<h1 align="center">Runlist<\/h1>/);
  assert.match(fold, /Start, stop, and switch local apps from one sidebar\./);
  assert.match(fold, /Every local app\. One sidebar\./);
  assert.match(fold, /See what’s running\. Stop it from here\./);
  assert.match(fold, /Ports, preview, and a stack you can start as a group\./);
  assert.doesNotMatch(fold, /runlist-preview\.png/);
  assert.doesNotMatch(fold, /^## /m);
});

test('keeps listing images on relative media/ paths and does not use the preview screenshot as the hero', () => {
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
});

test('ships the three Design gallery PNGs', () => {
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
  assert.match(readme, /Start, stop, and switch local apps from one sidebar/);
  assert.match(readme, /Every local app\. One sidebar/);
  assert.match(readme, /revalidates each process identity before termination/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/releases\/download/);
  assert.match(readme, /Install from the VS Code Marketplace/);
  assert.match(readme, /marketplace\.visualstudio\.com\/items\?itemName=hankoswart\.runlist/);
  assert.match(
    readme,
    /JSON file to move one or all saved setups.*review before they can run/is
  );
  assert.match(readme, /Run groups.*reverse order/is);
  assert.match(readme, /repair proposal.*current.*proposed.*Retry start/is);
});
