const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildStartFailureClipboardText,
  buildStopFailureClipboardText
} = require('../src/integrations/failure-clipboard');

test('buildStartFailureClipboardText redacts secrets and includes bounded output', () => {
  const text = buildStartFailureClipboardText({
    name: 'API',
    failureSummary: {
      title: 'Start failed',
      message: 'API_KEY=super-secret'
    },
    output: 'line one\nAuthorization: Bearer abc.def.ghi'
  });

  assert.match(text, /Runlist start failed — API/);
  assert.match(text, /Start failed/);
  assert.match(text, /API_KEY=\[redacted\]/);
  assert.match(text, /Recent output:/);
  assert.match(text, /line one/);
  assert.doesNotMatch(text, /super-secret|abc\.def\.ghi/);
});

test('buildStopFailureClipboardText uses stop failure detail', () => {
  const text = buildStopFailureClipboardText({
    name: 'Web',
    stopFailure: 'the custom stop command did not finish.',
    output: ''
  });

  assert.match(text, /Runlist stop failed — Web/);
  assert.match(text, /the custom stop command did not finish/);
  assert.match(text, /\(no output captured\)/);
});
