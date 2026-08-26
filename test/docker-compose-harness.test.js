const assert = require('node:assert/strict');
const test = require('node:test');
const {
  composeCommandToDockerArgs,
  splitCommandTokens
} = require('./helpers/docker-compose-harness');

test('splitCommandTokens preserves quoted paths with spaces', () => {
  assert.deepEqual(
    splitCommandTokens("docker compose -p 'my project' -f '/tmp/my stack/compose.yaml' up web"),
    ['docker', 'compose', '-p', 'my project', '-f', '/tmp/my stack/compose.yaml', 'up', 'web']
  );
});

test('composeCommandToDockerArgs returns argv for docker compose commands', () => {
  assert.deepEqual(
    composeCommandToDockerArgs("docker compose -p runlist-test -f '/tmp/acme/compose.yaml' stop web cache"),
    ['compose', '-p', 'runlist-test', '-f', '/tmp/acme/compose.yaml', 'stop', 'web', 'cache']
  );
  assert.deepEqual(
    composeCommandToDockerArgs('docker compose -f compose.yaml up web'),
    ['compose', '-f', 'compose.yaml', 'up', 'web']
  );
});
