const { redactSensitiveText } = require('../projects/project-diagnostics');

const CONNECTED_AGENT_ORDER = ['copilot', 'codex', 'claude'];
const HANDOFF_CAPABLE_AGENTS = new Set(['copilot']);
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

function hasHandoffReadyAgent(agentConnections) {
  return HANDOFF_CAPABLE_AGENTS.has('copilot')
    && agentConnections?.copilot?.status === 'success';
}

function hasConnectedAgent(agentConnections) {
  return hasHandoffReadyAgent(agentConnections);
}

function agentRegistrationStatus(agent, { setupComplete = false } = {}) {
  if (HANDOFF_CAPABLE_AGENTS.has(agent)) {
    return setupComplete ? 'success' : 'installed';
  }
  return setupComplete ? 'installed' : 'idle';
}

function agentHandoffConfirmationMessage(projectName) {
  const name = String(projectName || 'project').trim() || 'project';
  return `Opened VS Code chat with a prefilled diagnosis request for ${name}. Send the message when you are ready.`;
}

function firstConnectedAgent(agentConnections) {
  return hasHandoffReadyAgent(agentConnections) ? 'copilot' : undefined;
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
  HANDOFF_CAPABLE_AGENTS,
  agentHandoffConfirmationMessage,
  agentRegistrationStatus,
  buildDiagnosisHandoff,
  firstConnectedAgent,
  hasConnectedAgent,
  hasHandoffReadyAgent,
  openAgentHandoff,
  sanitizeFailureSummary
};
