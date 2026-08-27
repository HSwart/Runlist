const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const getStartedHeading = '## Get started';
const firstFold = readme.slice(0, readme.indexOf(getStartedHeading));

test('leads with the Marketplace gallery stills', () => {
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
    /src="media\/gallery-02-status\.png" width="1280" alt="See what\u2019s running and open it from here"/
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

test('keeps a professional Marketplace listing that matches shipped product', () => {
  assert.match(readme, /^# Runlist\n/);
  assert.match(firstFold, /Start, stop, and switch local apps from one sidebar\./);
  assert.match(firstFold, /Every local app, one place/);
  assert.match(firstFold, /Save the start command once/);
  assert.match(firstFold, /See what\u2019s running/);
  assert.match(firstFold, /Open the app when it\u2019s ready/);
  assert.match(firstFold, /Switch cleanly when a port is already in use/);

  assert.match(readme, /## Get started\n/);
  assert.match(readme, /Open the Runlist sidebar/);
  assert.match(readme, /Add this folder/);
  assert.match(readme, /Save the start command/);
  assert.match(readme, /`start` \/ `dev` chip/);
  assert.match(readme, /Start it from the list/);
  assert.match(readme, /First-run stays empty until you add a folder/);

  assert.match(readme, /## Everyday use\n/);
  assert.match(readme, /Start, stop, and restart from the project row/);
  assert.match(readme, /Open the app from the port chip/);
  assert.match(readme, /Checks configured ports before Start/);
  assert.match(readme, /Live preview and recent output/);
  assert.match(readme, /Open on phone/);
  assert.match(readme, /Windows, macOS, and Linux/);

  assert.match(readme, /## Also included\n/);
  assert.match(readme, /Launch profiles, tags, and groups/);
  assert.match(readme, /More menu \(\u22ef\)|More menu \(⋯\)/);
  assert.match(readme, /Load stack/);
  assert.match(readme, /Docker Compose import/);
  assert.match(readme, /Optional env file/);
  assert.match(readme, /Optional local hostname/);

  assert.match(readme, /Install from the \[VS Code Marketplace\]/);
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
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /SECURITY\.md/);
  assert.doesNotMatch(readme, /\[MIT License\]\(LICENSE\)/);
});

test('fails closed on overclaims and GitHub-raw image URLs', () => {
  assert.doesNotMatch(readme, /auto-kill|kill all|full-system port|Pro tier|free tier|paid/i);
  assert.doesNotMatch(readme, /Kubernetes|Tilt|Swarm|live_update/i);
  assert.doesNotMatch(readme, /full Portless|Caddy feature parity|puma-dev parity/i);
  assert.doesNotMatch(readme, /Not a local reverse proxy/i);
  assert.doesNotMatch(readme, /Infisical|Doppler|Vault/i);
  assert.doesNotMatch(readme, /auto-?apply|auto-?start.*stack|starts? on clone/i);
  assert.doesNotMatch(readme, /create worktrees|delete worktrees|manages? git worktrees/i);
  assert.doesNotMatch(readme, /Git worktrees with port variables get sticky temporary ports/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/raw\//);
  assert.doesNotMatch(readme, /gallery\.vsassets\.io/);
});
