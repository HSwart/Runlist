const path = require('node:path');
const { discoverWorkspacePackageCandidates } = require('./project-workspace');
const { discoverProcfileProcessCandidates } = require('./procfile-discovery');
const { discoverVscodeTaskCandidates } = require('./vscode-tasks-discovery');
const { discoverComposeImportCandidate } = require('../compose/compose-file');
const { workspaceStartDevScripts } = require('./project-workspace');

function workspaceImportKey(entry) {
  return `${entry.kind}:${entry.folder}:${entry.startCommand}:${entry.name}`;
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
  workspaceImportKey
};
