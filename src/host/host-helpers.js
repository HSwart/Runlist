const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  boundedDiagnosticOutput,
  redactSensitiveText
} = require('../projects/project-diagnostics');

async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
  const values = Array.from(items || []);
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array(values.length);
  let nextIndex = 0;
  let failure;

  const worker = async () => {
    while (!failure && !options.cancelled?.()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        failure ||= error;
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker()
  ));
  if (failure) {
    throw failure;
  }
  return results;
}

function shouldOfferReadyOpen({
  status,
  previewUrl,
  locallyOwned,
  alreadyOpened,
  generation,
  offeredGeneration,
  pending = false
} = {}) {
  if (pending || alreadyOpened || !locallyOwned) {
    return false;
  }
  if (status !== 'running') {
    return false;
  }
  if (typeof previewUrl !== 'string' || !previewUrl) {
    return false;
  }
  if (generation === undefined || generation === null || generation === '') {
    return false;
  }
  if (offeredGeneration === generation) {
    return false;
  }
  return true;
}

function readyOpenMessage(name) {
  return `${String(name || 'Project')} is ready.`;
}

function customStopPostcondition({
  commandSucceeded,
  hasConfiguredServices,
  hadTrackedOwnership,
  ownershipStopped,
  servicesStopped
}) {
  if (!commandSucceeded) {
    return 'command-failed';
  }
  if (!hasConfiguredServices && !hadTrackedOwnership) {
    return 'unverifiable';
  }
  if (ownershipStopped && servicesStopped) {
    return 'complete';
  }
  return 'partial';
}

function stopHonestyMessage({
  processActive = false,
  openPorts = [],
  webPort
} = {}) {
  if (processActive) {
    return 'Stop failed';
  }
  const ports = (Array.isArray(openPorts) ? openPorts : [])
    .filter((port) => Number.isInteger(port));
  if (ports.length === 0) {
    return '';
  }
  const port = ports.includes(webPort) ? webPort : ports[0];
  return `Port :${port} is still up`;
}

const PROJECT_DETAIL_TABS = Object.freeze({
  overview: 'overview',
  services: 'services',
  output: 'output',
  preview: 'preview',
  history: 'history'
});

function availableProjectDetailTabs({
  servicesAvailable = false,
  outputAvailable = false,
  previewAvailable = false,
  historyAvailable = false
} = {}) {
  return [
    PROJECT_DETAIL_TABS.overview,
    ...(servicesAvailable ? [PROJECT_DETAIL_TABS.services] : []),
    ...(outputAvailable ? [PROJECT_DETAIL_TABS.output] : []),
    ...(previewAvailable ? [PROJECT_DETAIL_TABS.preview] : []),
    ...(historyAvailable ? [PROJECT_DETAIL_TABS.history] : [])
  ];
}

function preferredProjectDetailTab(tabs, savedTab) {
  if (tabs.includes(savedTab)) {
    return savedTab;
  }
  return tabs.includes(PROJECT_DETAIL_TABS.preview)
    ? PROJECT_DETAIL_TABS.preview
    : PROJECT_DETAIL_TABS.overview;
}

function openProjectInNewWindow(vscode, folder) {
  return vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(folder),
    { forceNewWindow: true }
  );
}

function openWorkspaceFolderInCurrentWindow(vscode, folder) {
  return vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(folder),
    { forceNewWindow: false }
  );
}

function projectFolderIsAccessible(fileSystem, folder) {
  try {
    fileSystem.accessSync(
      folder,
      fileSystem.constants.R_OK | fileSystem.constants.X_OK
    );
    return fileSystem.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function openProjectTerminal(vscode, folder) {
  const terminal = vscode.window.createTerminal({
    cwd: folder
  });
  terminal.show();
  return terminal;
}

function copyProjectPath(vscode, folder) {
  return vscode.env.clipboard.writeText(folder);
}

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function projectSearchText(project) {
  return normalizeSearchQuery([
    project.name,
    project.folder,
    ...(Array.isArray(project.tags) ? project.tags : [])
  ].filter(Boolean).join('\n'));
}

const MAX_CLIPBOARD_OUTPUT_CHARS = 4000;

function formatFailureBody(title, message) {
  const lines = [];
  const safeTitle = redactSensitiveText(String(title || '').trim());
  const safeMessage = redactSensitiveText(String(message || '').trim());
  if (safeTitle) {
    lines.push(safeTitle);
  }
  if (safeMessage && safeMessage !== safeTitle) {
    lines.push(safeMessage);
  }
  return lines.join('\n');
}

function formatRecentOutput(output) {
  if (!output) {
    return '(no output captured)';
  }
  const bounded = boundedDiagnosticOutput(output, MAX_CLIPBOARD_OUTPUT_CHARS);
  const text = String(bounded.output || '').trim();
  return text || '(no output captured)';
}

function buildStartFailureClipboardText({ name, failureSummary, output }) {
  const projectName = String(name || 'project').trim() || 'project';
  const summary = failureSummary && typeof failureSummary === 'object' ? failureSummary : {};
  const body = formatFailureBody(summary.title || 'Start failed', summary.message || 'Start failed');
  return [
    `Runlist start failed — ${projectName}`,
    body,
    '',
    'Recent output:',
    formatRecentOutput(output)
  ].join('\n');
}

function buildStopFailureClipboardText({ name, stopFailure, output }) {
  const projectName = String(name || 'project').trim() || 'project';
  const body = formatFailureBody('Stop failed', stopFailure || 'Stop failed');
  return [
    `Runlist stop failed — ${projectName}`,
    body,
    '',
    'Recent output:',
    formatRecentOutput(output)
  ].join('\n');
}

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
  MAX_CLIPBOARD_OUTPUT_CHARS,
  PROJECT_DETAIL_TABS,
  availableProjectDetailTabs,
  buildStartFailureClipboardText,
  buildStopFailureClipboardText,
  copyProjectPath,
  customStopPostcondition,
  detectRuntimeDrift,
  mapWithConcurrency,
  normalizeSearchQuery,
  openProjectInNewWindow,
  openProjectTerminal,
  openWorkspaceFolderInCurrentWindow,
  preferredProjectDetailTab,
  probePythonVersion,
  projectFolderIsAccessible,
  projectSearchText,
  readyOpenMessage,
  shouldOfferReadyOpen,
  stopHonestyMessage
};
