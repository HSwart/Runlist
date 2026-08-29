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

test('hasHandoffReadyAgent only treats Copilot setup success as handoff-ready', () => {
  const { hasHandoffReadyAgent } = require('../src/integrations/diagnosis-handoff');
  assert.equal(hasHandoffReadyAgent({ copilot: { status: 'idle' } }), false);
  assert.equal(hasHandoffReadyAgent({ copilot: { status: 'installed' } }), false);
  assert.equal(hasHandoffReadyAgent({ copilot: { status: 'success' } }), true);
  assert.equal(hasHandoffReadyAgent({ codex: { status: 'success' } }), false);
  assert.equal(hasHandoffReadyAgent({ codex: { status: 'installed' } }), false);
});

test('hasConnectedAgent follows handoff-ready Copilot state', () => {
  assert.equal(hasConnectedAgent({ copilot: { status: 'idle' } }), false);
  assert.equal(hasConnectedAgent({ codex: { status: 'success' } }), false);
  assert.equal(hasConnectedAgent({ copilot: { status: 'success' } }), true);
});

test('agentRegistrationStatus distinguishes Copilot handoff from CLI agents', () => {
  const { agentRegistrationStatus } = require('../src/integrations/diagnosis-handoff');
  assert.equal(agentRegistrationStatus('copilot', { setupComplete: true }), 'success');
  assert.equal(agentRegistrationStatus('codex', { setupComplete: true }), 'installed');
  assert.equal(agentRegistrationStatus('claude', { setupComplete: true }), 'installed');
});

test('agentHandoffConfirmationMessage does not claim the draft was sent', () => {
  const { agentHandoffConfirmationMessage } = require('../src/integrations/diagnosis-handoff');
  assert.match(
    agentHandoffConfirmationMessage('API'),
    /prefilled diagnosis request for API/
  );
  assert.match(agentHandoffConfirmationMessage('API'), /Send the message when you are ready/);
  assert.doesNotMatch(agentHandoffConfirmationMessage('API'), /Sent .* to your agent/);
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
