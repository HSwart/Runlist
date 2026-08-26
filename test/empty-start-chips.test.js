const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { workspaceStartDevScripts } = require('../src/projects/project-workspace');
const { readShippedHostSource } = require('./helpers/extension-source');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const router = fs.readFileSync(path.join(root, 'media', 'message-router.js'), 'utf8');

test('reads only package.json start and dev scripts for empty-state chips', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-start-chips-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify({
    scripts: {
      start: 'node server.js',
      dev: 'vite',
      test: 'node --test',
      build: 'vite build'
    }
  }));

  assert.deepEqual(workspaceStartDevScripts(temporaryRoot), [
    { name: 'start', startCommand: 'npm start' },
    { name: 'dev', startCommand: 'npm run dev' }
  ]);
  assert.deepEqual(workspaceStartDevScripts(path.join(temporaryRoot, 'missing')), []);
});

test('empty Frame A keeps Add this folder and optional start/dev chips', () => {
  const extension = readShippedHostSource(root);
  assert.match(webview, /<h2>No projects yet<\/h2>/);
  assert.match(webview, /data-action="show-add">\$\{addLabel\}/);
  assert.match(webview, /class="empty-start-chips"/);
  assert.match(webview, /data-action="start-workspace-script" data-script="/);
  assert.match(webview, /state\.workspaceStartScripts/);
  assert.doesNotMatch(webview, /Task Explorer|every script|script dump/i);
  assert.match(styles, /\.empty-start-chip \{/);
  assert.match(router, /'startWorkspaceScript'/);
  assert.match(router, /\['start', 'dev'\]\.includes\(value\.script\)/);
  assert.match(extension, /async startWorkspaceScript\(scriptName\)/);
  assert.match(extension, /workspaceStartScripts: workspaceStartDevScripts\(/);
  assert.match(extension, /expectProjectAbsent: true/);
});
