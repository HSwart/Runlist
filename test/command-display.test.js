const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodePowerShellEncodedCommand,
  formatCommandForDisplay,
  windowsStartCommandIssues
} = require('../src/projects/command-display');

test('decodes PowerShell -EncodedCommand payloads for human review', () => {
  const script = "Write-Host 'hello'";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const command = `powershell.exe -NoProfile -EncodedCommand ${encoded}`;

  assert.equal(decodePowerShellEncodedCommand(command), script);
  assert.match(formatCommandForDisplay(command), /Write-Host 'hello'/);
  assert.match(formatCommandForDisplay(command), /-EncodedCommand/);
});

test('flags nested PowerShell quoting hazards on Windows start commands', () => {
  assert.deepEqual(windowsStartCommandIssues(
    'powershell -Command "npm start"',
    'win32'
  ), []);
  assert.deepEqual(windowsStartCommandIssues(
    'powershell -Command "powershell -Command \\"npm start\\""',
    'win32'
  ), [
    'Nested PowerShell -Command quoting often breaks under shell:true on Windows. Prefer a single -EncodedCommand or a plain script file.'
  ]);
  assert.deepEqual(windowsStartCommandIssues(
    'powershell -Command "powershell -Command \\"npm start\\""',
    'linux'
  ), []);
});
