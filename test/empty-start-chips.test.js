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

test('hides npm empty-state chips for Azure Functions Python folders', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-af-chips-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporaryRoot, 'host.json'), '{}');
  fs.writeFileSync(path.join(temporaryRoot, 'local.settings.json'), JSON.stringify({
    Values: { FUNCTIONS_WORKER_RUNTIME: 'python' }
  }));
  fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify({
    scripts: { start: 'echo monorepo', dev: 'echo monorepo' }
  }));
  fs.writeFileSync(path.join(temporaryRoot, 'requirements.txt'), 'azure-functions\n');

  assert.deepEqual(workspaceStartDevScripts(temporaryRoot), []);
});

test('empty Frame A keeps Add this folder and optional start/dev chips', () => {
  const extension = readShippedHostSource(root);
  assert.match(webview, /<h2>\$\{stackHeroCopy \? 'Load team stack' : 'No projects yet'\}<\/h2>/);
  assert.match(webview, /const addLabel = 'Add this folder'/);
  assert.match(webview, /data-action="show-add">\$\{addLabel\}<\/button>/);
  assert.match(webview, /Add \$\{workspaceFolderName \|\| 'the folder'\} open in this window\./);
  assert.match(webview, /class="empty-start-chips"/);
  assert.match(webview, /state\.projects\.length === 0/);
  assert.match(webview, /data-action="start-workspace-script" data-script="/);
  assert.match(webview, /const chipLabel = script\.name === 'dev' \? 'Dev' : 'Start'/);
  assert.match(webview, /Save and start \\`\$\{script\.startCommand\}\\` for this folder/);
  assert.doesNotMatch(webview, /Run \\`\$\{script\.startCommand\}\\` for this folder/);
  assert.match(webview, /state\.workspaceStartScripts/);
  assert.doesNotMatch(webview, /Task Explorer|every script|script dump/i);
  assert.match(styles, /\.empty-start-chip \{/);
  assert.match(router, /'startWorkspaceScript'/);
  assert.match(router, /\['start', 'dev'\]\.includes\(value\.script\)/);
  assert.match(extension, /async startWorkspaceScript\(scriptName\)/);
  assert.match(extension, /workspaceStartScripts: workspaceStartDevScripts\(/);
  assert.match(extension, /expectProjectAbsent: true/);
});

test('Add form offers Start/Dev chips that only fill the start command', () => {
  const extension = readShippedHostSource(root);
  assert.match(webview, /function draftStartScriptChipsHtml\(/);
  assert.match(webview, /state\.mode !== 'add'/);
  assert.match(webview, /role="group" aria-label="Suggested start commands for this folder"/);
  assert.match(webview, /data-action="use-draft-start-script"/);
  assert.match(webview, /Use \$\{script\.startCommand\} for the start command/);
  assert.match(webview, /Use \\u201C\$\{script\.startCommand\}\\u201D/);
  assert.match(webview, /type: 'useDraftStartScript'/);
  assert.match(webview, /caret === 'end'/);
  assert.match(webview, /role="status"/);
  assert.match(webview, /draftStartCommandNotice/);
  assert.match(router, /'useDraftStartScript'/);
  assert.match(extension, /async useDraftStartScript\(scriptName, draft = \{\}\)/);
  assert.match(extension, /draftStartScripts: this\.mode === 'add'/);
  assert.match(extension, /workspaceStartDevScripts\(String\(this\.draft\?\.folder \|\| ''\)\)/);
  const methodStart = extension.indexOf('async useDraftStartScript(scriptName, draft = {})');
  const methodEnd = extension.indexOf('async showProjectTransfer()', methodStart);
  const method = extension.slice(methodStart, methodEnd);
  assert.match(method, /this\.mode !== 'add'/);
  assert.match(method, /startCommand: chip\.startCommand/);
  assert.match(method, /Start command set to \$\{chip\.startCommand\}\./);
  assert.match(method, /id: 'start-command', caret: 'end'/);
  assert.doesNotMatch(method, /startProject\(/);
  assert.doesNotMatch(method, /startWorkspaceScript\(/);
  assert.doesNotMatch(method, /saveProject\(/);
  assert.doesNotMatch(method, /upsertProject\(/);
  assert.match(styles, /\.draft-start-chips \{[\s\S]*flex-wrap: wrap;[\s\S]*max-width: 100%/);
  assert.match(styles, /@media \(max-width: 300px\) \{[\s\S]*\.draft-start-chips \{[\s\S]*flex-wrap: wrap;/);
});

test('empty-state chips use Start/Dev labels with npm command hints', () => {
  assert.match(webview, /chipLabel = script\.name === 'dev' \? 'Dev' : 'Start'/);
  assert.match(webview, /aria-label="\$\{escapeHtml\(chipHint\)\}"/);
  assert.match(webview, /title="\$\{escapeHtml\(chipHint\)\}"/);
  assert.doesNotMatch(webview, /aria-label="Start \$\{escapeHtml\(script\.name\)\} for this folder"/);
});

test('running row Stop and Restart use at least 24px hit targets', () => {
  assert.match(styles, /\.run-button \{[\s\S]*min-width: 24px;[\s\S]*min-height: 24px;/);
  assert.match(styles, /\.more-button,\s*\.icon-button \{[\s\S]*min-width: 24px;[\s\S]*min-height: 24px;/);
  assert.match(styles, /\.project-actions \{[\s\S]*gap: 6px;/);
});

test('narrow sidebar keeps Frame B actions from collapsing', () => {
  assert.match(
    styles,
    /@media \(max-width: 300px\) \{[\s\S]*\.project-actions \{[\s\S]*\.run-button,[\s\S]*\.more-button \{[\s\S]*flex: 0 0 auto;/
  );
  assert.doesNotMatch(styles, /@media \(max-width: 300px\) \{[\s\S]*\.project-status span \{[\s\S]*text-overflow: ellipsis;/);
});
