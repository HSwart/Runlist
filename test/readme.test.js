const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const installHeading = '## Install';
const firstFold = readme.slice(0, readme.indexOf(installHeading));

test('leads with the signed Marketplace gallery stills', () => {
  const galleryPaths = [
    'media/gallery-01-hero.png',
    'media/gallery-02-status.png',
    'media/gallery-03-features.png'
  ];

  for (const screenshotPath of galleryPaths) {
    const screenshot = fs.readFileSync(path.join(root, screenshotPath));
    assert.ok(readme.indexOf(screenshotPath) < readme.indexOf(installHeading));
    assert.equal(screenshot.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(screenshot.readUInt32BE(16) >= 1000);
    assert.ok(screenshot.readUInt32BE(20) >= 700);
  }

  assert.match(
    readme,
    /gallery-01-hero\.png" width="1280" alt="Runlist in VS Code with every local app in one sidebar"/
  );
  assert.match(
    readme,
    /gallery-02-status\.png" width="1280" alt="See what’s running and stop it from here"/
  );
  assert.match(
    readme,
    /gallery-03-features\.png" width="1280" alt="First-run: no projects yet, add this folder"/
  );
  assert.doesNotMatch(firstFold, /runlist-preview\.png/);
  assert.doesNotMatch(firstFold, /\.svg/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
});

test('keeps README positioning and installation claims accurate', () => {
  assert.match(firstFold, /<h1 align="center">Runlist<\/h1>/);
  assert.match(firstFold, /Start, stop, and switch local apps from one sidebar\./);
  assert.match(firstFold, /Every local app\. One sidebar\./);
  assert.match(readme, /revalidates each process identity before termination/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/releases\/download/);
  assert.match(readme, /Install from the VS Code Marketplace/);
  assert.match(readme, /marketplace\.visualstudio\.com\/items\?itemName=hankoswart\.runlist/);
  assert.match(readme, /repair proposal.*current.*proposed.*Retry start/is);
  assert.match(readme, /Runlist: Add Project.*Command Palette also opens the sidebar/s);
  assert.match(readme, /Add this folder/);
  assert.match(readme, /This window.*folder is open in this VS Code window/is);
  assert.match(readme, /Start This Folder.*Command Palette/is);
  assert.match(readme, /add-project form hides launch profiles/i);
});
