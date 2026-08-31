const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, [
  'sbom',
  '--omit=dev',
  '--sbom-format=cyclonedx'
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || 'npm sbom failed.\n');
  process.exitCode = result.status || 1;
} else {
  const sbom = JSON.parse(result.stdout);
  const component = sbom.metadata?.component;
  const expectedPurl = `pkg:npm/${manifest.name}@${manifest.version}`;
  if (sbom.bomFormat !== 'CycloneDX'
    || sbom.specVersion !== '1.5'
    || component?.version !== manifest.version
    || component?.purl !== expectedPurl
    || !Array.isArray(sbom.components)
    || !Array.isArray(sbom.dependencies)) {
    throw new Error('Generated SBOM does not describe the current Runlist package.');
  }
  if (process.argv[2]) {
    fs.writeFileSync(path.resolve(root, process.argv[2]), `${JSON.stringify(sbom, null, 2)}\n`);
  }
  process.stdout.write('CycloneDX SBOM generation and package identity validation passed.\n');
}
