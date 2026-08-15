const { spawn } = require('child_process');

function ownedProcessSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? {} : { detached: true };
}

function terminateOwnedProcessTree(child, options = {}) {
  const platform = options.platform || process.platform;
  const killProcess = options.killProcess || process.kill;
  const spawnProcess = options.spawnProcess || spawn;

  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    return Promise.reject(new Error('Switchboard no longer has a valid process handle. No process was stopped.'));
  }
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.reject(new Error('The process Switchboard launched has already exited. No process was stopped.'));
  }

  if (platform !== 'win32') {
    try {
      killProcess(-child.pid, 'SIGTERM');
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    const taskkill = spawnProcess(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    taskkill.stderr?.setEncoding('utf8');
    taskkill.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    taskkill.once('error', reject);
    taskkill.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `taskkill exited with code ${code}.`));
    });
  });
}

async function terminateTrackedProcess(processes, id, options) {
  const child = processes.get(id);
  if (!child) {
    return false;
  }

  await terminateOwnedProcessTree(child, options);
  if (processes.get(id) === child) {
    processes.delete(id);
  }
  return true;
}

async function cleanupTrackedProcessForDeletion(processes, id, project, stopProject, options) {
  if (!processes.has(id)) {
    return false;
  }
  if (!project || project.reviewRequired) {
    return terminateTrackedProcess(processes, id, options);
  }

  stopProject(project);
  return true;
}

module.exports = {
  cleanupTrackedProcessForDeletion,
  ownedProcessSpawnOptions,
  terminateOwnedProcessTree,
  terminateTrackedProcess
};
