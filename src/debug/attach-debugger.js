/**
 * Attach VS Code's debugger to a Runlist-started process.
 * Never restarts the process. Fails closed when no folder debugger is available.
 */

function canAttachDebugger(project = {}, options = {}) {
  const status = String(options.status || project.status || 'stopped');
  if (!['running', 'not-ready', 'not-responding'].includes(status)) {
    return { ok: false, reason: 'Debug is available only while Runlist is running this app.' };
  }
  if (project.reviewRequired) {
    return { ok: false, reason: 'Review this setup before debugging.' };
  }
  if (project.lifecycleBlocked) {
    return { ok: false, reason: project.lifecycleBlockedReason || 'Lifecycle controls are unavailable.' };
  }
  if (options.detected || status === 'active') {
    return { ok: false, reason: 'Debug only attaches to processes Runlist started.' };
  }
  if (options.ownershipLost || status === 'ownership-lost') {
    return { ok: false, reason: 'Runlist no longer owns this process.' };
  }
  if (['port-in-use', 'port-in-use-unknown'].includes(status)) {
    return { ok: false, reason: 'Resolve the port conflict before debugging.' };
  }
  const pid = Number(options.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'No process ID is available to attach.' };
  }
  if (options.managed !== true) {
    return { ok: false, reason: 'Debug only attaches to processes Runlist started.' };
  }
  return { ok: true, pid };
}

async function attachDebuggerToProcess(vscode, options = {}) {
  const folder = typeof options.folder === 'string' ? options.folder.trim() : '';
  const pid = Number(options.pid);
  const name = typeof options.name === 'string' && options.name.trim()
    ? options.name.trim()
    : 'project';
  if (!folder) {
    return { ok: false, message: 'No debugger available for this folder.' };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: 'No process ID is available to attach.' };
  }

  const folderUri = vscode.Uri.file(folder);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder?.(folderUri)
    || {
      uri: folderUri,
      name: require('path').basename(folder),
      index: 0
    };

  const launchConfig = vscode.workspace.getConfiguration?.('launch', folderUri);
  const configurations = Array.isArray(launchConfig?.get?.('configurations'))
    ? launchConfig.get('configurations')
    : [];
  const attachConfigs = configurations.filter((config) => config
    && typeof config === 'object'
    && config.request === 'attach'
    && typeof config.type === 'string'
    && config.type.trim());

  const attempts = attachConfigs.length
    ? attachConfigs.map((config) => ({
      ...config,
      processId: pid,
      name: config.name || `Attach ${name}`
    }))
    : defaultAttachConfigurations(folder, pid, name);

  if (!attempts.length) {
    return { ok: false, message: 'No debugger available for this folder.' };
  }

  let lastError;
  for (const config of attempts) {
    try {
      const started = await vscode.debug.startDebugging(workspaceFolder, config);
      if (started) {
        return { ok: true };
      }
      lastError = new Error('Debugger did not start.');
    } catch (error) {
      lastError = error;
    }
  }

  const detail = String(lastError?.message || '').trim();
  if (/no debugger|not installed|could not find|unknown type/i.test(detail)) {
    return { ok: false, message: 'No debugger available for this folder.' };
  }
  return {
    ok: false,
    message: detail
      ? `Could not attach the debugger: ${detail}`
      : 'Could not attach the debugger.'
  };
}

function defaultAttachConfigurations(folder, pid, name) {
  const configs = [];
  if (folderLooksLikeNode(folder)) {
    configs.push({
      type: 'node',
      request: 'attach',
      name: `Attach ${name}`,
      processId: pid,
      cwd: folder
    });
  }
  if (folderLooksLikePython(folder)) {
    configs.push({
      type: 'python',
      request: 'attach',
      name: `Attach ${name}`,
      processId: pid,
      cwd: folder
    });
  }
  return configs;
}

function folderLooksLikeNode(folder) {
  try {
    const fs = require('fs');
    const path = require('path');
    return fs.existsSync(path.join(folder, 'package.json'));
  } catch {
    return false;
  }
}

function folderLooksLikePython(folder) {
  try {
    const fs = require('fs');
    const path = require('path');
    return ['pyproject.toml', 'requirements.txt', 'manage.py', 'Pipfile']
      .some((name) => fs.existsSync(path.join(folder, name)));
  } catch {
    return false;
  }
}

module.exports = {
  attachDebuggerToProcess,
  canAttachDebugger
};
