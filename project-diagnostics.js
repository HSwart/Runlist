const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeProjectOutput } = require('./project-output');

const MAX_DIAGNOSTIC_OUTPUT_CHARS = 12000;

function diagnosticsDirectory(projectsFile) {
  return path.join(path.dirname(projectsFile), 'failed-start-diagnostics');
}

function diagnosticsPath(projectsFile, projectId) {
  const fileName = crypto.createHash('sha256').update(String(projectId)).digest('hex');
  return path.join(diagnosticsDirectory(projectsFile), `${fileName}.json`);
}

function redactSensitiveText(value) {
  return sanitizeProjectOutput(String(value || ''))
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      '[redacted private key]'
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[redacted credential]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&][^=\s&#]+)=([^&#\s]*)/g, '$1=[redacted]')
    .replace(
      /(^|\s)(--(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|session))(=|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gim,
      '$1$2$3[redacted]'
    )
    .replace(
      /((?:npm_config_)?\/\/[^\s=]+:_auth(?:token)?\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]'
    )
    .replace(/\b([A-Z_][A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, '$1[redacted]')
    .replace(
      /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|session|database[_-]?url|connection[_-]?string)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]'
    );
}

function boundedDiagnosticOutput(output, limit = MAX_DIAGNOSTIC_OUTPUT_CHARS) {
  const clean = redactSensitiveText(output);
  if (clean.length <= limit) {
    return { output: clean, truncated: false };
  }
  let start = clean.length - limit;
  const firstCode = clean.charCodeAt(start);
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
    start += 1;
  }
  return { output: clean.slice(start), truncated: true };
}

function writeProjectDiagnostics(projectsFile, projectId, details = {}) {
  const bounded = boundedDiagnosticOutput(details.output);
  const summary = details.summary || {};
  const record = {
    projectId: String(projectId),
    platform: String(details.platform || process.platform).slice(0, 32),
    lifecycleState: String(details.lifecycleState || 'stopped').slice(0, 64),
    exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
    signal: typeof details.signal === 'string' && details.signal
      ? details.signal.slice(0, 32)
      : null,
    failureSummary: {
      title: redactSensitiveText(summary.title || 'Start failed').slice(0, 120),
      message: redactSensitiveText(summary.message || 'The start command did not complete.').slice(0, 1000),
      ...(summary.outcome
        ? { outcome: redactSensitiveText(summary.outcome).slice(0, 240) }
        : {})
    },
    retainedOutput: bounded.output,
    outputTruncated: bounded.truncated,
    failedAt: Number.isFinite(details.failedAt) ? details.failedAt : Date.now()
  };
  fs.mkdirSync(diagnosticsDirectory(projectsFile), { recursive: true, mode: 0o700 });
  const targetPath = diagnosticsPath(projectsFile, projectId);
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, targetPath);
  return record;
}

function readProjectDiagnostics(projectsFile, projectId) {
  try {
    const record = JSON.parse(fs.readFileSync(diagnosticsPath(projectsFile, projectId), 'utf8'));
    return record?.projectId === String(projectId) ? record : undefined;
  } catch {
    return undefined;
  }
}

function clearProjectDiagnostics(projectsFile, projectId) {
  try {
    fs.rmSync(diagnosticsPath(projectsFile, projectId), { force: true });
  } catch {
    // Diagnostics are optional and must never block core project actions.
  }
}

module.exports = {
  MAX_DIAGNOSTIC_OUTPUT_CHARS,
  boundedDiagnosticOutput,
  clearProjectDiagnostics,
  diagnosticsPath,
  readProjectDiagnostics,
  redactSensitiveText,
  writeProjectDiagnostics
};
