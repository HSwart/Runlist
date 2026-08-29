const {
  boundedDiagnosticOutput,
  redactSensitiveText
} = require('../projects/project-diagnostics');

const MAX_CLIPBOARD_OUTPUT_CHARS = 4000;

function formatFailureBody(title, message) {
  const lines = [];
  const safeTitle = redactSensitiveText(String(title || '').trim());
  const safeMessage = redactSensitiveText(String(message || '').trim());
  if (safeTitle) {
    lines.push(safeTitle);
  }
  if (safeMessage && safeMessage !== safeTitle) {
    lines.push(safeMessage);
  }
  return lines.join('\n');
}

function formatRecentOutput(output) {
  if (!output) {
    return '(no output captured)';
  }
  const bounded = boundedDiagnosticOutput(output, MAX_CLIPBOARD_OUTPUT_CHARS);
  const text = String(bounded.output || '').trim();
  return text || '(no output captured)';
}

function buildStartFailureClipboardText({ name, failureSummary, output }) {
  const projectName = String(name || 'project').trim() || 'project';
  const summary = failureSummary && typeof failureSummary === 'object' ? failureSummary : {};
  const body = formatFailureBody(summary.title || 'Start failed', summary.message || 'Start failed');
  return [
    `Runlist start failed — ${projectName}`,
    body,
    '',
    'Recent output:',
    formatRecentOutput(output)
  ].join('\n');
}

function buildStopFailureClipboardText({ name, stopFailure, output }) {
  const projectName = String(name || 'project').trim() || 'project';
  const body = formatFailureBody('Stop failed', stopFailure || 'Stop failed');
  return [
    `Runlist stop failed — ${projectName}`,
    body,
    '',
    'Recent output:',
    formatRecentOutput(output)
  ].join('\n');
}

module.exports = {
  MAX_CLIPBOARD_OUTPUT_CHARS,
  buildStartFailureClipboardText,
  buildStopFailureClipboardText
};
