const path = require('node:path');
const { readVSIXPackage } = require('@vscode/vsce/out/zip');

async function validateVsix(root, readPackage = readVSIXPackage) {
  const expected = require(path.join(root, 'package.json'));
  const { manifest: actual } = await readPackage(path.join(root, 'releases', 'runlist.vsix'));
  const mismatches = [];

  for (const field of ['publisher', 'name', 'version']) {
    if (actual[field] !== expected[field]) {
      mismatches.push(`${field} is ${actual[field]} in the VSIX but ${expected[field]} in package.json`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Refusing to publish a stale or incorrect VSIX: ${mismatches.join('; ')}. Run npm run package and review the new package first.`);
  }
}

if (require.main === module) {
  validateVsix(path.join(__dirname, '..'))
    .then(() => process.stdout.write('Marketplace VSIX identity and version match package.json.\n'))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { validateVsix };
