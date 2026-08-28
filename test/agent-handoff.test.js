const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildDiagnosisHandoffPrompt,
  connectedAgentReady,
  invokeConnectedAgentChat
} = require('../src/integrations/agent-handoff');

test('treats a successful Agent connections setup as connected', () => {
  assert.equal(connectedAgentReady({
    copilot: { status: 'idle' },
    codex: { status: 'success' },
    claude: { status: 'error' }
  }), true);
  assert.equal(connectedAgentReady({
    copilot: { status: 'idle' },
    codex: { status: 'error' }
  }), false);
});

test('builds a redacted handoff prompt with project id and repair coordinates', () => {
  const prompt = buildDiagnosisHandoffPrompt({
    id: 'project-1',
    name: 'Demo App'
  }, {
    failureSummary: { message: 'API_KEY=super-secret failed' },
    projectRevision: 'a'.repeat(64),
    failedAt: 1234
  });

  assert.match(prompt, /projectId "project-1"/);
  assert.match(prompt, /runlist_get_project_status/);
  assert.match(prompt, /runlist_get_project_diagnostics/);
  assert.match(prompt, /runlist_propose_project_repair/);
  assert.match(prompt, /failedAt 1234/);
  assert.doesNotMatch(prompt, /super-secret/);
  assert.match(prompt, /Do not run commands, start or stop the project/);
});

test('invokes the first working VS Code chat command with the sanitized prompt', async () => {
  const calls = [];
  const result = await invokeConnectedAgentChat(async (command, args) => {
    calls.push([command, args]);
    if (command === 'workbench.action.chat.openagent') {
      return;
    }
    throw new Error('command not found');
  }, 'Inspect project-1');

  assert.equal(result.ok, true);
  assert.equal(result.command, 'workbench.action.chat.openagent');
  assert.equal(calls[0][0], 'workbench.action.chat.open');
  assert.equal(calls[0][1].query, 'Inspect project-1');
  assert.equal(calls[0][1].isPartialQuery, false);
});

test('reports failure when no chat command is available', async () => {
  const result = await invokeConnectedAgentChat(async () => {
    throw new Error('command not found');
  }, 'Inspect project-1');
  assert.deepEqual(result, { ok: false });
});
