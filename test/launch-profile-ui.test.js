const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

test('keeps single-profile cards unchanged and reveals an accessible picker only for alternatives', () => {
  assert.match(main, /hasLaunchProfiles = launchProfiles\.length > 1/);
  assert.match(main, /role="menuitemradio" aria-checked=/);
  assert.match(main, /data-action="toggle-profile-menu"/);
  assert.match(main, /Stop this project to change profile\./);
  assert.match(styles, /\.launch-profile-trigger[\s\S]*text-overflow: ellipsis/);
});

test('edits launch profiles in the existing form without adding a project-card row', () => {
  assert.match(main, /class="launch-profile-editor"/);
  assert.match(main, /data-action="add-launch-profile"/);
  assert.match(main, /data-action="delete-launch-profile"/);
  assert.doesNotMatch(main, /class="project-profile-row"/);
});

test('keeps health checks inside the existing service Options disclosure', () => {
  assert.match(main, /<details class="service-options"/);
  assert.match(main, /name="serviceHealthMode"/);
  assert.match(main, /health\.mode === 'http'/);
  assert.match(main, /Health URL or path/);
  assert.doesNotMatch(main, /class="project-health-row"/);
  assert.match(styles, /\.service-health-fields/);
});
