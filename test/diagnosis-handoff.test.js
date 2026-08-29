const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AGENT_CHAT_COMMAND,
  buildDiagnosisHandoff,
  hasConnectedAgent,
  openAgentHandoff,
  sanitizeFailureSummary
} = require('../src/integrations/diagnosis-handoff');

test('buildDiagnosisHandoff includes revision, failedAt, and redacted summary', () => {
  const handoff = buildDiagnosisHandoff(
    { id: 'project-1', name: 'API' },
    {
      projectRevision: 'a'.repeat(64),
      failedAt: 1234,
      failureSummary: {
        title: 'Start failed',
        message: 'TOKEN=secret-value'
      }
    }
  );

  assert.match(handoff.prompt, /projectId "project-1"/);
  assert.match(handoff.prompt, /projectRevision a{64}/);
  assert.match(handoff.prompt, /failedAt 1234/);
  assert.match(handoff.prompt, /runlist_get_project_diagnostics/);
  assert.match(handoff.prompt, /TOKEN=\[redacted\]/);
  assert.doesNotMatch(handoff.prompt, /secret-value/);
  assert.equal(handoff.failureSummary.message, 'TOKEN=[redacted]');
});

test('sanitizeFailureSummary preserves missing-required-env kind', () => {
  const summary = sanitizeFailureSummary({
    title: 'Start failed',
    message: 'Missing API_KEY.',
    kind: 'missing-required-env'
  });
  assert.equal(summary.kind, 'missing-required-env');
});

test('hasConnectedAgent follows agent connection success state', () => {
  assert.equal(hasConnectedAgent({ copilot: { status: 'idle' } }), false);
  assert.equal(hasConnectedAgent({ codex: { status: 'success' } }), true);
});

test('openAgentHandoff opens chat with a partial query', async () => {
  const calls = [];
  await openAgentHandoff('Diagnose my app.', async (command, args) => {
    calls.push([command, args]);
  });
  assert.deepEqual(calls, [[AGENT_CHAT_COMMAND, {
    query: 'Diagnose my app.',
    isPartialQuery: true
  }]]);
});
