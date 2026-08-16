const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('leads with the stylized Runlist preview', () => {
  const screenshotPath = 'media/runlist-preview.png';
  const screenshot = fs.readFileSync(path.join(root, screenshotPath));

  assert.ok(readme.indexOf(screenshotPath) < readme.indexOf('## A control panel'));
  assert.match(readme, /runlist-preview\.png" width="900" alt="Stylized preview/);
  assert.equal(screenshot.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(screenshot.readUInt32BE(16) >= 1900);
});

test('keeps README positioning and installation claims accurate', () => {
  assert.match(readme, /Every local app, across every repository/);
  assert.match(readme, /optionally let a supported coding agent propose the setup for your approval/);
  assert.match(readme, /never stops an unknown process to free one/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/releases\/download/);
  assert.match(readme, /Install from the VS Code Marketplace/);
  assert.match(readme, /marketplace\.visualstudio\.com\/items\?itemName=hankoswart\.runlist/);
});
