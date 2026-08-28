const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

function readShippedHostSource(root = repoRoot) {
  return [
    fs.readFileSync(path.join(root, 'extension.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'src', 'host', 'runlist-view-provider.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'src', 'host', 'project-run-terminal.js'), 'utf8')
  ].join('\n');
}

module.exports = { readShippedHostSource };
