const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodePowerShellEncodedCommand,
  formatCommandForDisplay,
  stripPackageManagerSilentFlags,
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

test('strips only npm/pnpm/yarn silent flags and preserves concurrently -s', () => {
  assert.equal(stripPackageManagerSilentFlags('npm run dev --silent'), 'npm run dev');
  assert.equal(stripPackageManagerSilentFlags('npm -s start'), 'npm start');
  assert.equal(stripPackageManagerSilentFlags('pnpm --silent start'), 'pnpm start');
  assert.equal(
    stripPackageManagerSilentFlags('npx concurrently -k -s first "npm:web" "npm:api"'),
    'npx concurrently -k -s first "npm:web" "npm:api"'
  );
  assert.equal(
    stripPackageManagerSilentFlags('npm run start -- --silent'),
    'npm run start -- --silent'
  );
  assert.equal(stripPackageManagerSilentFlags('python app.py --silent'), 'python app.py --silent');
});
