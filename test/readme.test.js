const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const getStartedHeading = '## Get started';
const firstFold = readme.slice(0, readme.indexOf(getStartedHeading));

test('leads with the signed Marketplace gallery stills', () => {
  const galleryPaths = [
    'media/gallery-01-hero.png',
    'media/gallery-02-status.png',
    'media/gallery-03-features.png'
  ];

  for (const screenshotPath of galleryPaths) {
    const screenshot = fs.readFileSync(path.join(root, screenshotPath));
    assert.ok(readme.includes(screenshotPath));
    assert.equal(screenshot.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(screenshot.readUInt32BE(16) >= 1000);
    assert.ok(screenshot.readUInt32BE(20) >= 700);
  }

  assert.match(
    readme,
    /gallery-01-hero\.png" width="1280" alt="Every local app in one VS Code sidebar"/
  );
  assert.match(
    readme,
    /gallery-02-status\.png" width="1280" alt="See what’s running, elapsed time, and open from the port"/
  );
  assert.match(
    readme,
    /gallery-03-features\.png" width="1280" alt="First-run: no projects yet, add this folder"/
  );
  assert.ok(readme.indexOf('media/gallery-01-hero.png') < readme.indexOf(getStartedHeading));
  assert.ok(readme.indexOf('media/gallery-02-status.png') > readme.indexOf(getStartedHeading));
  assert.doesNotMatch(firstFold, /runlist-preview\.png/);
  assert.doesNotMatch(readme, /\.svg/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/raw\//);
  assert.doesNotMatch(readme, /media\/runlist\.png/);
});

test('keeps a Marketplace listing that sells shipped behavior', () => {
  assert.match(readme, /^# Runlist\n/);
  assert.match(firstFold, /Start, stop, and switch local apps from one sidebar\./);
  assert.match(firstFold, /Every local app, one sidebar/);
  assert.match(firstFold, /stop or restart from the row/);
  assert.match(firstFold, /Open the app from its port/);
  assert.match(readme, /## Get started/);
  assert.match(readme, /Add this folder/);
  assert.match(readme, /`start` \/ `dev` chip/);
  assert.match(readme, /## Features/);
  assert.match(readme, /Start, stop, and restart from the running row/);
  assert.match(readme, /Port chip opens the app at a stable `name\.localhost` URL/);
  assert.match(readme, /Launch profiles, tags, and run groups/);
  assert.match(readme, /Live preview, recent output, and open-on-phone/);
  assert.match(readme, /Import or export project setups/);
  assert.match(readme, /Windows, macOS, and Linux/);
  assert.match(
    readme,
    /Install from the \[VS Code Marketplace\]\(https:\/\/marketplace\.visualstudio\.com\/items\?itemName=hankoswart\.runlist\)\./
  );
  assert.match(readme, /Publisher Hanko Swart\. `hankoswart\.runlist`\./);
  assert.doesNotMatch(readme, /<h1 align="center">Runlist<\/h1>/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/releases\/download/);
  assert.doesNotMatch(readme, /## Install\b/);
  assert.doesNotMatch(readme, /## Contributing/);
  assert.doesNotMatch(readme, /## Security/);
  assert.doesNotMatch(readme, /## Optional:/);
  assert.doesNotMatch(readme, /## Day-to-day use/);
  assert.doesNotMatch(readme, /SECURITY\.md/);
  assert.doesNotMatch(readme, /\[MIT License\]\(LICENSE\)/);
});
