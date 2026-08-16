const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_STARTUP_HISTORY = 5;
const STARTUP_OUTCOMES = new Set(['ready', 'failed', 'timed-out']);

function startupHistoryDirectory(projectsFile, projectId) {
  const key = crypto.createHash('sha256').update(String(projectId)).digest('hex');
  return path.join(path.dirname(projectsFile), 'startup-history', key);
}

function startupHistoryEntry(outcome, launchedAt, completedAt = Date.now()) {
  if (!STARTUP_OUTCOMES.has(outcome)
    || !Number.isFinite(launchedAt)
    || !Number.isFinite(completedAt)
    || completedAt < launchedAt) {
    return undefined;
  }
  return {
    outcome,
    completedAt: Math.round(completedAt),
    durationMs: Math.round(completedAt - launchedAt)
  };
}

function appendStartupHistory(projectsFile, projectId, entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) {
    throw new TypeError('Startup history entry is invalid.');
  }

  const directory = startupHistoryDirectory(projectsFile, projectId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const targetPath = path.join(directory, `${normalized.completedAt}-${id}.json`);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, targetPath);

  const entries = readHistoryFiles(directory);
  for (const stale of entries.slice(0, -MAX_STARTUP_HISTORY)) {
    try {
      fs.rmSync(path.join(directory, stale.fileName), { force: true });
    } catch {
      // Another VS Code window may have pruned the same entry.
    }
  }
  return entries.slice(-MAX_STARTUP_HISTORY).map(({ entry: value }) => value);
}

function readStartupHistory(projectsFile, projectId) {
  return readHistoryFiles(startupHistoryDirectory(projectsFile, projectId))
    .slice(-MAX_STARTUP_HISTORY)
    .map(({ entry }) => entry);
}

function clearStartupHistory(projectsFile, projectId) {
  try {
    fs.rmSync(startupHistoryDirectory(projectsFile, projectId), { recursive: true, force: true });
  } catch {
    // History is optional and must never block project deletion.
  }
}

function readHistoryFiles(directory) {
  let fileNames;
  try {
    fileNames = fs.readdirSync(directory)
      .filter((fileName) => /^\d+-[0-9a-f-]+\.json$/i.test(fileName));
  } catch {
    return [];
  }

  return fileNames.map((fileName) => {
    try {
      const entry = normalizeEntry(JSON.parse(fs.readFileSync(path.join(directory, fileName), 'utf8')));
      return entry ? { entry, fileName } : undefined;
    } catch {
      return undefined;
    }
  }).filter(Boolean).sort((left, right) => (
    left.entry.completedAt - right.entry.completedAt
      || left.fileName.localeCompare(right.fileName)
  ));
}

function normalizeEntry(value) {
  if (!value || !STARTUP_OUTCOMES.has(value.outcome)
    || !Number.isFinite(value.completedAt)
    || !Number.isFinite(value.durationMs)
    || value.completedAt < 0
    || value.durationMs < 0) {
    return undefined;
  }
  return {
    outcome: value.outcome,
    completedAt: Math.round(value.completedAt),
    durationMs: Math.round(value.durationMs)
  };
}

module.exports = {
  appendStartupHistory,
  clearStartupHistory,
  MAX_STARTUP_HISTORY,
  readStartupHistory,
  startupHistoryDirectory,
  startupHistoryEntry
};
