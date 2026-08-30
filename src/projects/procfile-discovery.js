const fs = require('node:fs');
const path = require('node:path');

const PROCFILE_NAMES = Object.freeze(['Procfile.dev', 'Procfile']);

function parseProcfileContents(contents) {
  const processes = [];
  const seen = new Set();
  for (const line of String(contents ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const name = match[1].trim();
    const startCommand = match[2].trim();
    if (!name || !startCommand || seen.has(name)) {
      continue;
    }
    seen.add(name);
    processes.push({ name, startCommand });
  }
  return processes;
}

function discoverProcfileProcessCandidates(rootFolder, options = {}) {
  if (typeof rootFolder !== 'string' || !rootFolder.trim()) {
    return [];
  }
  const readFileSync = options.readFileSync || fs.readFileSync;
  const existsSync = options.existsSync || fs.existsSync;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  const processes = [];
  const seen = new Set();
  for (const fileName of PROCFILE_NAMES) {
    const filePath = path.join(rootFolder, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const entry of parseProcfileContents(contents)) {
      if (seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      processes.push({
        folder: rootFolder,
        name: entry.name,
        startCommand: entry.startCommand,
        sourceFile: fileName
      });
    }
  }
  return processes
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit);
}

module.exports = {
  PROCFILE_NAMES,
  discoverProcfileProcessCandidates,
  parseProcfileContents
};
