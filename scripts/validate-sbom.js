const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const npmSbomArgs = [
  'sbom',
  '--omit=dev',
  '--sbom-format=cyclonedx'
];

function npmSbomInvocation(platform = process.platform, environment = process.env) {
  if (platform === 'win32') {
    return {
      command: environment.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', ...npmSbomArgs]
    };
  }
  return {
    command: 'npm',
    args: npmSbomArgs
  };
}

function validateSbom(outputPath = process.argv[2]) {
  const invocation = npmSbomInvocation();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'npm sbom failed.\n');
    process.exitCode = result.status || 1;
    return;
  }
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
  if (outputPath) {
    fs.writeFileSync(path.resolve(root, outputPath), `${JSON.stringify(sbom, null, 2)}\n`);
  }
  process.stdout.write('CycloneDX SBOM generation and package identity validation passed.\n');
}

if (require.main === module) {
  validateSbom();
}

module.exports = {
  npmSbomInvocation,
  validateSbom
};
