const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

// Source contracts for progressive disclosure on first add.
// Runtime render coverage lives in webview-render-runtime.test.js.

test('first-add form wraps advanced fields in a More options details block', () => {
  assert.match(webview, /class="more-options"/);
  assert.match(webview, /<summary>[^<]*More options[^<]*<\/summary>/);
  assert.match(styles, /\.more-options\s*\{/);
  assert.match(styles, /\.more-options\s*>\s*summary/);

  const formStart = webview.indexOf("app.innerHTML = `\n    <section class=\"add-screen\">");
  assert.ok(formStart !== -1);
  const formEnd = webview.indexOf('function draftStartScriptChipsHtml()', formStart);
  const form = webview.slice(formStart, formEnd);

  const folderIdx = form.indexOf('id="folder"');
  const startIdx = form.indexOf('id="start-command"');
  const moreIdx = form.indexOf('class="more-options"');
  const nameIdx = form.indexOf('id="project-name"');
  const hostnameIdx = form.indexOf('id="local-hostname"');
  const tagsIdx = form.indexOf('id="tags"');
  const stopIdx = form.indexOf('id="stop-command"');
  const envFileIdx = form.indexOf('id="env-file"');
  const saveIdx = form.indexOf('Save project');

  assert.ok(folderIdx !== -1 && startIdx !== -1 && moreIdx !== -1);
  assert.ok(folderIdx < moreIdx, 'folder stays outside More options');
  assert.ok(startIdx < moreIdx, 'start command stays outside More options');
  assert.ok(nameIdx > moreIdx, 'project name is inside More options region');
  assert.ok(hostnameIdx > moreIdx, 'local hostname is inside More options region');
  assert.ok(tagsIdx > moreIdx, 'tags are inside More options region');
  assert.ok(stopIdx > moreIdx, 'stop command is inside More options region');
  assert.ok(envFileIdx > moreIdx, 'env file is inside More options region');
  assert.ok(saveIdx > moreIdx, 'Save stays after More options');
});

test('first add opens More options only when advanced draft values already exist', () => {
  assert.match(
    webview,
    /const isFirstAdd = state\.mode === 'add' && !reviewing/
  );
  assert.match(webview, /advancedOpen/);
  assert.match(
    webview,
    /<details class="more-options"\$\{advancedOpen \? ' open' : ''\}>/
  );
});
