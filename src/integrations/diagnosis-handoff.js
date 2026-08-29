const { redactSensitiveText } = require('../projects/project-diagnostics');

const CONNECTED_AGENT_ORDER = ['copilot', 'codex', 'claude'];
const AGENT_CHAT_COMMAND = 'workbench.action.chat.open';

function sanitizeFailureSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return undefined;
  }
  const sanitized = {
    title: redactSensitiveText(summary.title || 'Start failed').slice(0, 120),
    message: redactSensitiveText(summary.message || '').slice(0, 1000)
  };
  if (summary.outcome) {
    sanitized.outcome = redactSensitiveText(summary.outcome).slice(0, 240);
  }
  if (summary.kind === 'missing-required-env') {
    sanitized.kind = summary.kind;
  }
  return sanitized;
}

function buildDiagnosisHandoff(project, diagnostic) {
  const failureSummary = sanitizeFailureSummary(diagnostic.failureSummary);
  const summaryDetail = failureSummary?.message
    ? ` Failure summary: ${failureSummary.title} — ${failureSummary.message}.`
    : '';
  const prompt = [
    `Help me diagnose ${project.name}'s latest failed Runlist start (projectId "${project.id}").`,
    `Use the Runlist MCP tool runlist_get_project_diagnostics with projectId "${project.id}" to inspect the retained failure.`,
    `Use projectRevision ${diagnostic.projectRevision} and failedAt ${diagnostic.failedAt} for any repair proposal.${summaryDetail}`,
    'Explain the likely cause and the smallest safe fix.',
    'If the saved setup should change, use runlist_propose_project_repair with the returned revision and failedAt value so I can review it in Runlist.',
    'Do not run commands or change the saved setup yourself.'
  ].join(' ');
  return {
    prompt,
    projectId: project.id,
    projectRevision: diagnostic.projectRevision,
    failedAt: diagnostic.failedAt,
    failureSummary
  };
}

function hasConnectedAgent(agentConnections) {
  return Object.values(agentConnections || {}).some((connection) => connection?.status === 'success');
}

function firstConnectedAgent(agentConnections) {
  return CONNECTED_AGENT_ORDER.find((agent) => agentConnections?.[agent]?.status === 'success');
}

async function openAgentHandoff(prompt, executeCommand) {
  if (typeof executeCommand !== 'function') {
    throw new TypeError('executeCommand is required.');
  }
  await executeCommand(AGENT_CHAT_COMMAND, {
    query: prompt,
    isPartialQuery: true
  });
}

module.exports = {
  AGENT_CHAT_COMMAND,
  CONNECTED_AGENT_ORDER,
  buildDiagnosisHandoff,
  firstConnectedAgent,
  hasConnectedAgent,
  openAgentHandoff,
  sanitizeFailureSummary
};
