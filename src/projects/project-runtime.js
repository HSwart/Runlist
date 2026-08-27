const fs = require('fs');
const path = require('path');

const PROJECT_RUNTIMES = Object.freeze([
  'azure-functions-python',
  'azure-functions-node',
  'python',
  'node',
  'unknown'
]);

function normalizeProjectRuntime(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Project runtime must be text.');
  }
  const runtime = value.trim().toLowerCase();
  if (!PROJECT_RUNTIMES.includes(runtime)) {
    throw new Error(`Project runtime must be one of: ${PROJECT_RUNTIMES.join(', ')}.`);
  }
  return runtime;
}

function classifyProjectRuntime(folder, options = {}) {
  if (typeof folder !== 'string' || !folder.trim()) {
    return 'unknown';
  }
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const root = folder.trim();

  const hostJsonPath = path.join(root, 'host.json');
  if (existsSync(hostJsonPath)) {
    const worker = azureFunctionsWorkerRuntime(root, { existsSync, readFileSync });
    if (worker === 'python') {
      return 'azure-functions-python';
    }
    if (worker === 'node' || worker === 'nodejs') {
      return 'azure-functions-node';
    }
    if (existsSync(path.join(root, 'function_app.py'))
      || existsSync(path.join(root, 'requirements.txt'))) {
      return 'azure-functions-python';
    }
    if (existsSync(path.join(root, 'package.json'))) {
      return 'azure-functions-node';
    }
  }

  const hasPythonMarkers = existsSync(path.join(root, 'pyproject.toml'))
    || existsSync(path.join(root, 'requirements.txt'))
    || existsSync(path.join(root, 'Pipfile'))
    || existsSync(path.join(root, 'function_app.py'));
  const hasNodeMarkers = packageJsonHasScripts(root, readFileSync);

  // Monorepo roots often have package.json workspaces beside a Python worker.
  // Prefer explicit Python-only markers; never invent Node when both exist.
  if (hasPythonMarkers && !hasNodeMarkers) {
    return 'python';
  }
  if (hasPythonMarkers && hasNodeMarkers) {
    const worker = azureFunctionsWorkerRuntime(root, { existsSync, readFileSync });
    if (worker === 'python') {
      return 'azure-functions-python';
    }
    return 'unknown';
  }
  if (hasNodeMarkers) {
    return 'node';
  }
  if (hasPythonMarkers) {
    return 'python';
  }
  return 'unknown';
}

function azureFunctionsWorkerRuntime(folder, options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  const existsSync = options.existsSync || fs.existsSync;
  const settingsPath = path.join(folder, 'local.settings.json');
  if (!existsSync(settingsPath)) {
    return undefined;
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const worker = settings?.Values?.FUNCTIONS_WORKER_RUNTIME
      || settings?.values?.FUNCTIONS_WORKER_RUNTIME;
    return typeof worker === 'string' ? worker.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function packageJsonHasScripts(folder, readFileSync = fs.readFileSync) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const scripts = packageJson?.scripts;
    return Boolean(
      scripts
      && typeof scripts === 'object'
      && !Array.isArray(scripts)
      && Object.keys(scripts).length > 0
    );
  } catch {
    return false;
  }
}

function runtimeAllowsNpmStartChips(runtime) {
  return runtime === 'node' || runtime === 'azure-functions-node';
}

module.exports = {
  PROJECT_RUNTIMES,
  classifyProjectRuntime,
  normalizeProjectRuntime,
  runtimeAllowsNpmStartChips
};
