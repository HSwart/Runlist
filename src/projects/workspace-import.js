const fs = require('node:fs');
const path = require('node:path');
const { discoverWorkspacePackageCandidates } = require('./project-workspace');
const { discoverProcfileProcessCandidates } = require('./procfile-discovery');
const { discoverVscodeTaskCandidates } = require('./vscode-tasks-discovery');
const { discoverComposeImportCandidate } = require('../compose/compose-file');
const { workspaceStartDevScripts } = require('./project-workspace');

function workspaceImportKey(entry) {
  return `${entry.kind}:${entry.folder}:${entry.startCommand}:${entry.name}`;
}

function workspaceImportFolderKey(folder) {
  const trimmed = String(folder || '').trim();
  if (!trimmed) {
    return '';
  }
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
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
  buildWorkspaceImportProposal,
  consolidateChosenImportEntries,
  workspaceImportKey,
  workspaceImportFolderKey
};
