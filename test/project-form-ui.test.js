const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

test('renders the complete service list with accessible add and remove controls', () => {
  assert.match(mainSource, /state\.draft\.services \|\| \[\]/);
  assert.match(mainSource, /data-action="add-service"/);
  assert.match(mainSource, /data-action="remove-service" aria-label="Remove/);
  assert.match(mainSource, /id="service-change-status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(mainSource, /id="app-port"/);
});

test('keeps service name, port, and remove controls in a compact responsive row', () => {
  assert.match(styleSource, /\.service-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 76px 28px/s);
  assert.match(styleSource, /\.service-field\s*\{[^}]*min-width:\s*0/s);
});
