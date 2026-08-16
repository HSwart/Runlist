const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('leads with the readable straight sidebar screenshot', () => {
  const screenshotPath = 'media/switchboard-screenshot.png';
  const screenshot = fs.readFileSync(path.join(root, screenshotPath));

  assert.ok(readme.indexOf(screenshotPath) < readme.indexOf('## A control panel'));
  assert.match(readme, /switchboard-screenshot\.png" width="680" alt="Straight view/);
  assert.equal(screenshot.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(screenshot.readUInt32BE(16) >= 1000);
});

test('keeps README positioning and downloads accurate', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const expectedDownload = `https://github.com/HSwart/Switchboard/releases/download/v${manifest.version}/switchboard.vsix`;
  const downloadLinks = readme.match(/https:\/\/github\.com\/HSwart\/Switchboard\/releases\/download\/[^)"<]+/g);

  assert.match(readme, /Every local app, across every repository/);
  assert.match(readme, /optionally let a supported coding agent propose the setup for your approval/);
  assert.match(readme, /never stops an unknown process to free one/);
  assert.ok(downloadLinks.length > 0);
  assert.deepEqual(new Set(downloadLinks), new Set([expectedDownload]));
});
