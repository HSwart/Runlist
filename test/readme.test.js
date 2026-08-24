const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('leads with the generated current Runlist preview', () => {
  const screenshotPath = 'media/runlist-preview.png';
  const screenshot = fs.readFileSync(path.join(root, screenshotPath));

  assert.ok(readme.indexOf(screenshotPath) < readme.indexOf('## A control panel'));
  assert.match(readme, /runlist-preview\.png" width="900" alt="Current Runlist/);
  assert.equal(screenshot.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(screenshot.readUInt32BE(16) >= 1000);
  assert.ok(screenshot.readUInt32BE(20) >= 700);
});

test('keeps README positioning and installation claims accurate', () => {
  assert.match(readme, /Every local app, across every repository/);
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
