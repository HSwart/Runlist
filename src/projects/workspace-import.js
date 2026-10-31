const fs = require('node:fs');
const path = require('node:path');
const { discoverWorkspacePackageCandidates } = require('./project-workspace');
const { discoverComposeImportCandidate } = require('../compose/compose-file');
const { workspaceStartDevScripts } = require('./project-workspace');

const PROCFILE_NAMES = Object.freeze(['Procfile.dev', 'Procfile']);
const TASKS_RELATIVE_PATH = path.join('.vscode', 'tasks.json');
const ALLOWED_NPM_SCRIPTS = new Set(['start', 'dev']);

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

function normalizeTaskFolder(rootFolder, taskPath) {
  if (typeof taskPath !== 'string' || !taskPath.trim()) {
    return rootFolder;
  }
  return path.resolve(rootFolder, taskPath.trim());
}

function discoverVscodeTaskCandidates(rootFolder, options = {}) {
  if (typeof rootFolder !== 'string' || !rootFolder.trim()) {
    return [];
  }
  const readFileSync = options.readFileSync || fs.readFileSync;
  const existsSync = options.existsSync || fs.existsSync;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  const tasksPath = path.join(rootFolder, TASKS_RELATIVE_PATH);
  if (!existsSync(tasksPath)) {
    return [];
  }
  let document;
  try {
    document = JSON.parse(readFileSync(tasksPath, 'utf8'));
  } catch {
    return [];
  }
  const tasks = Array.isArray(document?.tasks) ? document.tasks : [];
  const candidates = [];
  const seen = new Set();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      continue;
    }
    if (task.type !== 'npm' || typeof task.script !== 'string' || !ALLOWED_NPM_SCRIPTS.has(task.script)) {
      continue;
    }
    const folder = normalizeTaskFolder(rootFolder, task.path);
    const startCommand = task.script === 'start' ? 'npm start' : 'npm run dev';
    const name = typeof task.label === 'string' && task.label.trim()
      ? task.label.trim()
      : task.script;
    const key = `${folder}\0${startCommand}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({
      folder,
      name,
      scriptName: task.script,
      startCommand
    });
  }
  return candidates
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit);
}

function workspaceImportKey(entry) {
  return `${entry.kind}:${entry.folder}:${entry.startCommand}:${entry.name}`;
}

function workspaceImportFolderKey(folder) {
  const trimmed = String(folder || '').trim();
  if (!trimmed) {
    return '';
  }
  let resolved;
  try {
    resolved = fs.realpathSync(trimmed);
  } catch {
    resolved = path.resolve(trimmed);
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return resolved.toLocaleLowerCase();
  }
  return resolved;
}

function preferImportEntry(left, right) {
  const leftDev = /(?:^|\s)dev(?:\s|$)/i.test(left.startCommand || '') || left.name === 'Dev';
  const rightDev = /(?:^|\s)dev(?:\s|$)/i.test(right.startCommand || '') || right.name === 'Dev';
  if (leftDev !== rightDev) {
    return leftDev ? left : right;
  }
  return left.name.localeCompare(right.name) <= 0 ? left : right;
}

function consolidateChosenImportEntries(entries) {
  const byFolder = new Map();
  for (const entry of entries) {
    const folderKey = workspaceImportFolderKey(entry.folder);
    const group = byFolder.get(folderKey) || [];
    group.push(entry);
    byFolder.set(folderKey, group);
  }

  const consolidated = [];
  const skipped = [];
  for (const group of byFolder.values()) {
    const composeEntries = group.filter((entry) => entry.kind === 'compose');
    const projectEntries = group.filter((entry) => entry.kind !== 'compose');
    if (composeEntries.length && projectEntries.length) {
      throw new Error(
        `Cannot import both Compose and separate projects for the same folder (${group[0].folder}). Deselect one of them.`
      );
    }
    if (composeEntries.length > 1) {
      throw new Error(
        `Multiple Compose imports were selected for the same folder (${group[0].folder}). Choose one.`
      );
    }
    if (composeEntries.length === 1) {
      consolidated.push(composeEntries[0]);
      continue;
    }
    if (!projectEntries.length) {
      continue;
    }
    let chosen = projectEntries[0];
    for (let index = 1; index < projectEntries.length; index += 1) {
      chosen = preferImportEntry(chosen, projectEntries[index]);
    }
    consolidated.push(chosen);
    for (const entry of projectEntries) {
      if (entry !== chosen) {
        skipped.push(entry);
      }
    }
  }
  return { entries: consolidated, skipped };
}

function buildWorkspaceImportProposal(workspaceRoot, options = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    return { entries: [], composeCandidate: undefined };
  }
  const entries = [];
  const seen = new Set();
  const pushEntry = (entry) => {
    const key = workspaceImportKey(entry);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({
      selected: true,
      reviewRequired: true,
      ...entry
    });
  };

  for (const script of workspaceStartDevScripts(workspaceRoot)) {
    pushEntry({
      kind: 'project',
      source: 'package.json',
      name: script.name === 'dev' ? 'Dev' : 'Start',
      folder: workspaceRoot,
      startCommand: script.startCommand
    });
  }
  for (const entry of discoverWorkspacePackageCandidates(workspaceRoot, options)) {
    pushEntry({
      kind: 'project',
      source: 'workspace package',
      name: entry.name,
      folder: entry.folder,
      startCommand: entry.startCommand
    });
  }
  for (const entry of discoverProcfileProcessCandidates(workspaceRoot, options)) {
    pushEntry({
      kind: 'project',
      source: entry.sourceFile || 'Procfile',
      name: entry.name,
      folder: entry.folder,
      startCommand: entry.startCommand
    });
  }
  for (const entry of discoverVscodeTaskCandidates(workspaceRoot, options)) {
    pushEntry({
      kind: 'project',
      source: 'VS Code task',
      name: entry.name,
      folder: entry.folder,
      startCommand: entry.startCommand
    });
  }

  const composeCandidate = discoverComposeImportCandidate(workspaceRoot);
  if (composeCandidate) {
    pushEntry({
      kind: 'compose',
      source: composeCandidate.composeFiles.join(', '),
      name: path.basename(workspaceRoot) || 'Compose stack',
      folder: workspaceRoot,
      startCommand: '',
      composeFiles: composeCandidate.composeFiles
    });
  }

  return {
    entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
    composeCandidate
  };
}

module.exports = {
  ALLOWED_NPM_SCRIPTS,
  PROCFILE_NAMES,
  TASKS_RELATIVE_PATH,
  buildWorkspaceImportProposal,
  consolidateChosenImportEntries,
  discoverProcfileProcessCandidates,
  discoverVscodeTaskCandidates,
  parseProcfileContents,
  workspaceImportKey,
  workspaceImportFolderKey
};
