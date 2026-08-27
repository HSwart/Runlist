const WINDOWS_NESTED_POWERSHELL = /powershell(?:\.exe)?\b[\s\S]*-Command\b[\s\S]*powershell(?:\.exe)?\b[\s\S]*-Command\b/i;
const ENCODED_COMMAND_PATTERN = /(?:^|[\s/])(?:-|\/)?(?:EncodedCommand|ec)\b\s+([A-Za-z0-9+/=]+)/i;

function decodePowerShellEncodedCommand(command) {
  const match = String(command || '').match(ENCODED_COMMAND_PATTERN);
  if (!match) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf16le');
    return decoded.includes('\u0000') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function formatCommandForDisplay(command) {
  const text = String(command || '');
  const decoded = decodePowerShellEncodedCommand(text);
  if (!decoded) {
    return text;
  }
  return `${text}\n# Decoded PowerShell:\n${decoded}`;
}

function windowsStartCommandIssues(command, platform = process.platform) {
  if (platform !== 'win32') {
    return [];
  }
  const text = String(command || '');
  if (!WINDOWS_NESTED_POWERSHELL.test(text)) {
    return [];
  }
  return [
    'Nested PowerShell -Command quoting often breaks under shell:true on Windows. Prefer a single -EncodedCommand or a plain script file.'
  ];
}

function stripPackageManagerSilentFlags(command) {
  const text = String(command || '');
  if (!/^\s*(?:npm|pnpm|yarn|npx)\b/i.test(text)) {
    return text;
  }
  return text
    .replace(/(^|\s)--silent\b/g, '$1')
    .replace(/(^|\s)-s\b(?=\s|$)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = {
  decodePowerShellEncodedCommand,
  formatCommandForDisplay,
  stripPackageManagerSilentFlags,
  windowsStartCommandIssues
};
