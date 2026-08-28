const { redactSensitiveText } = require('../projects/project-diagnostics');

const CHAT_INVOCATIONS = [
  (prompt) => ['workbench.action.chat.open', {
    query: prompt,
    isPartialQuery: false,
    mode: 'agent'
  }],
  (prompt) => ['workbench.action.chat.openagent', {
    query: prompt,
    isPartialQuery: false
  }],
  (prompt) => ['workbench.action.chat.open', {
    query: prompt,
    isPartialQuery: false
  }],
  (prompt) => ['workbench.action.chat.open', prompt]
];

function connectedAgentReady(agentConnections) {
  return Object.values(agentConnections || {}).some((connection) => connection?.status === 'success');
}

function buildDiagnosisHandoffPrompt(project, diagnostic = {}) {
  const name = redactSensitiveText(project?.name || 'this project').slice(0, 200);
  const projectId = String(project?.id || '').slice(0, 256);
  const summary = redactSensitiveText(diagnostic.failureSummary?.message || '').slice(0, 240);
  const revision = typeof diagnostic.projectRevision === 'string'
    && /^[a-f0-9]{64}$/.test(diagnostic.projectRevision)
    ? diagnostic.projectRevision
    : '';
  const failedAt = Number.isFinite(diagnostic.failedAt) ? diagnostic.failedAt : '';
  return [
    `Use the Runlist MCP tools for ${name}.`,
    `Call runlist_get_project_status with projectId "${projectId}", then runlist_get_project_diagnostics with that same projectId to inspect the latest failed start.`,
    summary ? `Failure summary: ${summary}` : '',
    revision && failedAt !== ''
      ? `If the saved setup should change, use runlist_propose_project_repair with projectRevision "${revision}" and failedAt ${failedAt} so I can review it in Runlist.`
      : 'If the saved setup should change, use runlist_propose_project_repair with the returned revision and failedAt value so I can review it in Runlist.',
    'Do not run commands, start or stop the project, or change the saved setup yourself.'
  ].filter(Boolean).join(' ');
}

async function invokeConnectedAgentChat(executeCommand, prompt) {
  if (typeof executeCommand !== 'function' || typeof prompt !== 'string' || !prompt) {
    return { ok: false };
  }
  for (const build of CHAT_INVOCATIONS) {
    const [command, args] = build(prompt);
    try {
      await executeCommand(command, args);
      return { ok: true, command };
    } catch {
      // Try the next VS Code chat command. Clipboard fallback happens in the host.
    }
  }
  return { ok: false };
}

module.exports = {
  buildDiagnosisHandoffPrompt,
  connectedAgentReady,
  invokeConnectedAgentChat
};
