const assert = require('node:assert/strict');
const test = require('node:test');
const {
  boundedDiagnosticOutput,
  redactSensitiveText
} = require('../src/projects/project-diagnostics');
const { redactKnownEnvValues } = require('../src/projects/launch-env');

test('redacts known launch env values from diagnostics-style payloads', () => {
  const secret = 'super-secret-token-value';
  const raw = `boot ok TOKEN=${secret} and also ${secret} leaked`;
  const redacted = redactSensitiveText(redactKnownEnvValues(raw, [secret]));
  assert.doesNotMatch(redacted, /super-secret-token-value/);
  assert.match(redacted, /\[redacted\]/);
  assert.doesNotMatch(boundedDiagnosticOutput(redacted).output, /super-secret/);
});
