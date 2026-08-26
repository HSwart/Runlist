const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_PROJECT_OUTPUT_CHARS,
  appendProjectOutput,
  startFailureSummary
} = require('../src/projects/project-output');

const host = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'host', 'runlist-view-provider.js'),
  'utf8'
);
const parse = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'compose', 'compose-parse.js'),
  'utf8'
);

test('Compose start keeps attached output pipes and bounded Recent Output', () => {
  assert.match(host, /listenToProjectOutput\(child/);
  assert.match(host, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.doesNotMatch(host, /docker compose logs -f|compose logs --follow/);
  assert.doesNotMatch(parse, /docker compose up -d/);
  const flooded = 'x'.repeat(MAX_PROJECT_OUTPUT_CHARS + 5000);
  const bounded = appendProjectOutput('', flooded);
  assert.equal(bounded.length, MAX_PROJECT_OUTPUT_CHARS);
});

test('Compose-style start failures produce a useful failure summary', () => {
  const pull = startFailureSummary(
    'Pulling api\nError response from daemon: pull access denied for example/missing\n',
    { code: 1 }
  );
  assert.equal(pull.title, 'Start failed');
  assert.match(pull.message, /pull access denied|Error response from daemon/i);

  const bind = startFailureSummary(
    'Error: bind for 0.0.0.0:4310 failed: port is already allocated\n',
    { code: 1 }
  );
  assert.match(bind.message, /port is already allocated|bind for/i);

  const daemon = startFailureSummary('', {
    detail: 'Docker is not running. Start Docker, then try again.'
  });
  assert.match(daemon.message, /Docker is not running/i);
});
