const fs = require('node:fs');
const path = require('node:path');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function releaseNotesFromChangelog(changelog, version) {
  const pattern = new RegExp(
    `^## ${escapeRegExp(version)} — ([^\\n]+)\\n+([\\s\\S]*?)(?=^## |\\z)`,
    'm'
  );
  const match = String(changelog).replace(/\r\n/g, '\n').match(pattern);
  if (!match) {
    throw new Error(`CHANGELOG.md does not include a section for ${version}.`);
  }
  const title = match[1].trim();
  const bullets = match[2].trim();
  return [
    `## ${title}`,
    '',
    bullets,
    '',
    '**Install:** VS Code Marketplace (`hankoswart.runlist`) or download `runlist.vsix` from this release.',
    '',
    'Marketplace: run **Publish Marketplace** on `main`.'
  ].join('\n');
}

function releaseNotesForCurrentVersion(root = path.join(__dirname, '..')) {
  const manifest = require(path.join(root, 'package.json'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  return releaseNotesFromChangelog(changelog, manifest.version);
}

if (require.main === module) {
  const version = process.argv[2];
  const root = path.join(__dirname, '..');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const notes = version
    ? releaseNotesFromChangelog(changelog, version)
    : releaseNotesForCurrentVersion(root);
  process.stdout.write(`${notes}\n`);
}

module.exports = {
  releaseNotesForCurrentVersion,
  releaseNotesFromChangelog
};
