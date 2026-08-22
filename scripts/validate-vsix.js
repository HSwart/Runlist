const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVSIX, PackageManager } = require('@vscode/vsce');
const { readVSIXPackage, readZip } = require('@vscode/vsce/out/zip');

const TEXT_ARCHIVE_PATH = /(?:\.(?:css|js|json|md|svg|txt|ya?ml|xml)|vsixmanifest)$/i;

function archiveContentsEqual(archivePath, reviewed, candidate) {
  if (!TEXT_ARCHIVE_PATH.test(archivePath)) {
    return reviewed.equals(candidate);
  }
  return reviewed.toString('utf8').replaceAll('\r\n', '\n')
    === candidate.toString('utf8').replaceAll('\r\n', '\n');
}

function archiveContentMismatches(reviewed, candidate) {
  const paths = [...new Set([...reviewed.keys(), ...candidate.keys()])].sort();
  return paths.flatMap((archivePath) => {
    const reviewedContent = reviewed.get(archivePath);
    const candidateContent = candidate.get(archivePath);
    if (!reviewedContent) {
      return [`${archivePath} is missing from the reviewed VSIX`];
    }
    if (!candidateContent) {
      return [`${archivePath} is not shipped by the current source`];
    }
    return archiveContentsEqual(archivePath, reviewedContent, candidateContent)
      ? []
      : [`${archivePath} differs`];
  });
}

async function validateVsix(root, dependencies = {}) {
  const readPackage = typeof dependencies === 'function'
    ? dependencies
    : dependencies.readPackage || readVSIXPackage;
  const createCandidate = dependencies.createCandidate || createVSIX;
  const readArchive = dependencies.readArchive || ((packagePath) => readZip(packagePath, () => true));
  const expected = require(path.join(root, 'package.json'));
  const reviewedPath = path.join(root, 'releases', 'runlist.vsix');
  const { manifest: actual } = await readPackage(reviewedPath);
  const mismatches = [];

  for (const field of ['publisher', 'name', 'version']) {
    if (actual[field] !== expected[field]) {
      mismatches.push(`${field} is ${actual[field]} in the VSIX but ${expected[field]} in package.json`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Refusing to publish a stale or incorrect VSIX: ${mismatches.join('; ')}. Run npm run package and review the new package first.`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vsix-validation-'));
  const candidatePath = path.join(temporaryDirectory, 'runlist-candidate.vsix');
  try {
    await createCandidate({
      cwd: root,
      packageManager: PackageManager.None,
      packagePath: candidatePath
    });
    const [reviewed, candidate] = await Promise.all([
      readArchive(reviewedPath),
      readArchive(candidatePath)
    ]);
    const contentMismatches = archiveContentMismatches(reviewed, candidate);
    if (contentMismatches.length > 0) {
      const shown = contentMismatches.slice(0, 10);
      const remaining = contentMismatches.length - shown.length;
      throw new Error(
        `Refusing to publish a stale or incorrect VSIX: packaged contents do not match current source (${shown.join('; ')}${remaining > 0 ? `; and ${remaining} more` : ''}). Run npm run package and review the new package first.`
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  validateVsix(path.join(__dirname, '..'))
    .then(() => process.stdout.write('Marketplace VSIX identity, version, and packaged contents match current source.\n'))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { archiveContentMismatches, validateVsix };
