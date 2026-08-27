const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function probePythonVersion(command, options = {}) {
  const run = options.spawnSync || spawnSync;
  const result = run(command, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs || 3000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const match = text.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match?.[1];
}

function detectRuntimeDrift(project = {}, options = {}) {
  const runtime = project.runtime || '';
  if (!['python', 'azure-functions-python'].includes(runtime)) {
    return undefined;
  }
  const folder = typeof project.folder === 'string' ? project.folder : '';
  if (!folder) {
    return undefined;
  }
  const existsSync = options.existsSync || fs.existsSync;
  const pathSep = options.pathSep || path.sep;
  const venvPython = process.platform === 'win32'
    ? path.join(folder, '.venv', 'Scripts', 'python.exe')
    : path.join(folder, '.venv', 'bin', 'python');
  if (!existsSync(venvPython)) {
    return undefined;
  }
  const systemPython = options.systemPython
    || probePythonVersion(process.platform === 'win32' ? 'python' : 'python3', options)
    || probePythonVersion('python', options);
  const venvVersion = probePythonVersion(venvPython, options);
  if (!systemPython || !venvVersion || systemPython === venvVersion) {
    return undefined;
  }
  return {
    kind: 'python-version-mismatch',
    message: `Saved runtime expects Python, but the project venv is ${venvVersion} while the default python on PATH is ${systemPython}. Prefer the venv interpreter in the start command.`,
    systemPython,
    venvPython: venvVersion,
    venvPath: venvPython.split(path.sep).join(pathSep)
  };
}

module.exports = {
  detectRuntimeDrift,
  probePythonVersion
};
