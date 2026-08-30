const fs = require('node:fs');
const path = require('node:path');

const TASKS_RELATIVE_PATH = path.join('.vscode', 'tasks.json');
const ALLOWED_NPM_SCRIPTS = new Set(['start', 'dev']);

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

module.exports = {
  ALLOWED_NPM_SCRIPTS,
  TASKS_RELATIVE_PATH,
  discoverVscodeTaskCandidates
};
