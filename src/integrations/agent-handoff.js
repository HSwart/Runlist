const { redactSensitiveText } = require('../projects/project-diagnostics');

const AGENT_CHAT_COMMAND = 'workbench.action.chat.open';

function agentConnectionReady(agentConnections) {
  return Object.values(agentConnections || {}).some(
    (connection) => connection && connection.status === 'success'
  );
}

function buildDiagnosisHandoffPrompt({ project, diagnostics } = {}) {
  const id = String(project?.id || '').trim();
  const name = redactSensitiveText(String(project?.name || 'this project')).slice(0, 120);
  const summary = diagnostics?.failureSummary || {};
  const title = redactSensitiveText(String(summary.title || 'Start failed')).slice(0, 120);
  const message = redactSensitiveText(
    String(summary.message || 'The start command did not complete.')
  ).slice(0, 1000);
  const failureLine = `Failure: ${title}. ${message}`;
  const parts = [
    `Diagnose this Runlist start failure for ${name}.`,
    `Project ID: ${id}.`,
    /[.!?]$/.test(failureLine) ? failureLine : `${failureLine}.`
  ];
  if (typeof diagnostics?.projectRevision === 'string' && diagnostics.projectRevision) {
    parts.push(`Revision: ${diagnostics.projectRevision}.`);
  }
  if (Number.isFinite(diagnostics?.failedAt)) {
    parts.push(`Failed at: ${diagnostics.failedAt}.`);
  }
  parts.push(
    `Use the Runlist MCP tool runlist_get_project_diagnostics with projectId "${id}" to inspect ${name}'s latest failed start.`,
    'Explain the likely cause and the smallest safe fix.',
    'If the saved setup should change, use runlist_propose_project_repair with the returned revision and failedAt value so I can review it in Runlist.',
    'Do not run commands or change the saved setup yourself.'
  );
  return parts.join(' ');
}

async function sendDiagnosisToAgentChat(vscode, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return false;
  }
  if (typeof vscode?.commands?.executeCommand !== 'function') {
    return false;
  }
  try {
    if (typeof vscode.commands.getCommands === 'function') {
      const commands = await vscode.commands.getCommands(true);
      if (Array.isArray(commands) && !commands.includes(AGENT_CHAT_COMMAND)) {
        return false;
      }
    }
    await vscode.commands.executeCommand(AGENT_CHAT_COMMAND, { query: prompt });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  AGENT_CHAT_COMMAND,
  agentConnectionReady,
  buildDiagnosisHandoffPrompt,
  sendDiagnosisToAgentChat
};
