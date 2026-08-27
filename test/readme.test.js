const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const getStartedHeading = '## Get started';
const firstFold = readme.slice(0, readme.indexOf(getStartedHeading));

const signedReadme = [
  '# Runlist',
  '',
  'Start, stop, and switch local apps from one sidebar.',
  '',
  '<img src="media/gallery-01-hero.png" width="1280" alt="Every local app in one VS Code sidebar">',
  '',
  '- Every local app, one sidebar',
  '- Save the command once',
  '- See what\u2019s running, stop it from here',
  '- Switch when a port is already in use',
  '',
  '## Get started',
  '1. Open the Runlist sidebar',
  '2. Add this folder',
  '3. Save the start command',
  '4. Start it from the list',
  '',
  '<img src="media/gallery-02-status.png" width="1280" alt="See what\u2019s running and stop it from here">',
  '',
  'See what\u2019s running. Stop it from here.',
  '',
  '<img src="media/gallery-03-features.png" width="1280" alt="First-run: no projects yet, add this folder">',
  '',
  'First-run: no projects yet, add this folder.',
  '',
  '## Features',
  '- Start, stop, and restart from the card',
  '- Checks the port before it starts',
  '- Open the app in your browser',
  '- Windows, macOS, and Linux',
  '',
  'Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hankoswart.runlist).',
  '',
  'Publisher Hanko Swart. `hankoswart.runlist`.',
  ''
].join('\n');

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
    /src="media\/gallery-01-hero\.png" width="1280" alt="Every local app in one VS Code sidebar"/
  );
  assert.match(
    readme,
    /src="media\/gallery-02-status\.png" width="1280" alt="See what\u2019s running and stop it from here"/
  );
  assert.match(
    readme,
    /src="media\/gallery-03-features\.png" width="1280" alt="First-run: no projects yet, add this folder"/
  );
  assert.ok(readme.indexOf('media/gallery-01-hero.png') < readme.indexOf(getStartedHeading));
  assert.ok(readme.indexOf('media/gallery-02-status.png') > readme.indexOf(getStartedHeading));
  assert.ok(readme.indexOf('media/gallery-03-features.png') > readme.indexOf(getStartedHeading));
  assert.doesNotMatch(firstFold, /runlist-preview\.png/);
  assert.doesNotMatch(readme, /\.svg/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/raw\//);
  assert.doesNotMatch(readme, /media\/runlist\.png/);
});

test('locks the CoS-signed Marketplace listing verbatim', () => {
  assert.equal(readme, signedReadme);
  assert.match(readme, /^# Runlist\n/);
  assert.match(firstFold, /Start, stop, and switch local apps from one sidebar\./);
  assert.match(firstFold, /Every local app, one sidebar/);
  assert.match(firstFold, /Save the command once/);
  assert.match(firstFold, /See what\u2019s running, stop it from here/);
  assert.match(firstFold, /Switch when a port is already in use/);
  assert.match(readme, /## Get started\n1\. Open the Runlist sidebar\n2\. Add this folder\n3\. Save the start command\n4\. Start it from the list\n/);
  assert.match(readme, /See what\u2019s running\. Stop it from here\./);
  assert.match(readme, /First-run: no projects yet, add this folder\./);
  assert.match(readme, /## Features\n- Start, stop, and restart from the card\n- Checks the port before it starts\n- Open the app in your browser\n- Windows, macOS, and Linux\n/);
  assert.match(readme, /Install from the \[VS Code Marketplace\]/);
  assert.match(readme, /Add this folder/);
  assert.match(readme, /Windows, macOS, and Linux/);
  assert.match(
    readme,
    /\[VS Code Marketplace\]\(https:\/\/marketplace\.visualstudio\.com\/items\?itemName=hankoswart\.runlist\)/
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

test('fails closed on the old Marketplace essay and GitHub-raw image URLs', () => {
  assert.doesNotMatch(readme, /## Everyday use/);
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /A VS Code sidebar for starting, stopping, and opening local dev apps\./);
  assert.doesNotMatch(readme, /stop or restart from the row/);
  assert.doesNotMatch(readme, /Open the app from its port/);
  assert.doesNotMatch(readme, /`start` \/ `dev` chip/);
  assert.doesNotMatch(readme, /Start, stop, and restart from the running row/);
  assert.doesNotMatch(readme, /Port chip opens the app at a stable `name\.localhost` URL/);
  assert.doesNotMatch(readme, /Launch profiles, tags, and run groups/);
  assert.doesNotMatch(readme, /Live preview, recent output, and open-on-phone/);
  assert.doesNotMatch(readme, /Import or export project setups/);
  assert.doesNotMatch(readme, /elapsed time, and open from the port/);
  assert.doesNotMatch(readme, /First-run stays empty until you add a folder/);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/raw\//);
  assert.doesNotMatch(readme, /gallery\.vsassets\.io/);
});
