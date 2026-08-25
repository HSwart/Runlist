const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const main = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

test('keeps single-profile cards unchanged and reveals an accessible picker only for alternatives', () => {
  assert.match(main, /hasLaunchProfiles = launchProfiles\.length > 1/);
  assert.match(main, /role="menuitemradio" aria-checked=/);
  assert.match(main, /data-action="toggle-profile-menu"/);
  assert.match(main, /Stop this project to change profile\./);
  assert.match(styles, /\.launch-profile-trigger[\s\S]*text-overflow: ellipsis/);
});

test('namespaces project action and launch profile menus independently', () => {
  assert.match(main, /launchProfileMenuId = `profile:\$\{projectId\}`/);
  assert.match(main, /projectActionMenuId = `actions:\$\{projectId\}`/);
  assert.match(main, /data-menu-target="\$\{projectActionMenuId\}"/);
  assert.match(main, /data-menu-id="\$\{launchProfileMenuId\}"/);
});

test('keeps action and profile menus usable in narrow sidebars', () => {
  assert.match(main, /!\['toggle-menu', 'toggle-profile-menu'\]\.includes\(button\.dataset\.action\)/);
  assert.match(main, /menuBounds\.right > window\.innerWidth - 8/);
  assert.match(styles, /\.action-menu \{[\s\S]*width: min\(174px, calc\(100vw - 20px\)\)/);
  assert.match(styles, /\.launch-profile-menu\.open-left/);
  assert.match(styles, /@media \(max-width: 200px\)[\s\S]*\.service-row/);
});

test('restores rerendered menu focus to a visible trigger', () => {
  assert.match(main, /element\?\.closest\('\.action-menu\[hidden\]'\)/);
  assert.match(main, /\.menu-trigger\[data-menu-target=/);
});

test('edits launch profiles in the existing form without adding a project-card row', () => {
  assert.match(main, /class="launch-profile-editor"/);
  assert.match(main, /data-action="add-launch-profile"/);
  assert.match(main, /data-action="delete-launch-profile"/);
  assert.doesNotMatch(main, /class="project-profile-row"/);
  assert.match(main, /name: fieldValue\('launchProfileName'\)/);
  assert.doesNotMatch(main, /name: fieldValue\('launchProfileName'\) \|\| profile\.name/);
  assert.match(main, /selectedLaunchProfileId: String\(state\.draft\.selectedLaunchProfileId \|\| 'default'\)/);
  assert.doesNotMatch(main, /selectedLaunchProfileId: fieldValue\('launchProfileId'\)/);
  assert.match(main, /draft\.selectedLaunchProfileId = event\.target\.value/);
});

test('keeps health checks inside the existing service Options disclosure', () => {
  assert.match(main, /<details class="service-options"/);
  assert.match(main, /name="serviceHealthMode"/);
  assert.match(main, /health\.mode === 'http'/);
  assert.match(main, /Health URL or path/);
  assert.doesNotMatch(main, /class="project-health-row"/);
  assert.match(styles, /\.service-health-fields/);
});

test('uses the effective launch profile for timeline and failed-stop state', () => {
  const extension = readShippedHostSource();

  assert.match(extension, /projectHasLiveTimeline\(project\.id, runtimeProject, status\)/);
  assert.match(extension, /const project = projectStopStrategy\([\s\S]*const hasServices = Boolean\(project\?\.services\?\.length\)/);
  assert.match(extension, /previousDiagnostic[\s\S]*activeLaunchProfileId \|\| previousDiagnostic\?\.launchProfileId/);
});
