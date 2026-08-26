const fs = require('node:fs');
const path = require('node:path');

function localWorkspaceFolders(workspaceFolders = []) {
  return workspaceFolders.filter((workspaceFolder) => (
    workspaceFolder?.uri?.scheme === 'file'
    && typeof workspaceFolder.uri.fsPath === 'string'
    && workspaceFolder.uri.fsPath.length > 0
  ));
}

function canUseCurrentWorkspace(workspaceFolders) {
  return localWorkspaceFolders(workspaceFolders).length > 0;
}

function normalizeFolderIdentity(folder, platform = process.platform) {
  if (typeof folder !== 'string' || !folder.trim()) {
    return '';
  }
  const trimmed = folder.trim().replace(/[\\/]+$/, '');
  if (platform === 'win32') {
    return trimmed.replace(/\//g, '\\').toLowerCase();
  }
  return trimmed;
}

function foldersReferToSamePath(left, right, platform = process.platform) {
  const first = normalizeFolderIdentity(left, platform);
  const second = normalizeFolderIdentity(right, platform);
  return Boolean(first) && first === second;
}

function currentWorkspaceFolderPath(workspaceFolders) {
  const folders = localWorkspaceFolders(workspaceFolders);
  return folders.length === 1 ? folders[0].uri.fsPath : undefined;
}

function starterDraftForCurrentWorkspace(workspaceFolders) {
  const folder = currentWorkspaceFolderPath(workspaceFolders);
  return folder ? { folder } : {};
}

function workspaceFolderMatchesProject(projectFolder, workspaceFolders, platform = process.platform) {
  return localWorkspaceFolders(workspaceFolders).some((workspaceFolder) => (
    foldersReferToSamePath(projectFolder, workspaceFolder.uri.fsPath, platform)
  ));
}

function orderSidebarProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const pinned = list.filter((project) => project.pinned === true);
  const unpinned = list
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => project.pinned !== true)
    .sort((left, right) => {
      const delta = projectLastStartedAt(right.project) - projectLastStartedAt(left.project);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map(({ project }) => project);
  return [...pinned, ...unpinned];
}

function projectLastStartedAt(project = {}) {
  let latest = 0;
  if (Number.isFinite(project.timeline?.launchedAt)) {
    latest = Math.max(latest, project.timeline.launchedAt);
  }
  for (const entry of project.startupHistory || []) {
    if (!Number.isFinite(entry?.completedAt) || !Number.isFinite(entry?.durationMs)) {
      continue;
    }
    latest = Math.max(latest, entry.completedAt - entry.durationMs);
  }
  return latest;
}

function projectForCurrentWindow(projects, workspaceFolders, platform = process.platform) {
  const marked = (Array.isArray(projects) ? projects : []).map((project) => ({
    ...project,
    currentWorkspace: workspaceFolderMatchesProject(project.folder, workspaceFolders, platform)
  }));
  return orderSidebarProjects(marked).find((project) => project.currentWorkspace === true);
}

function startThisFolderDecision(projects, workspaceFolders, platform = process.platform) {
  if (!canUseCurrentWorkspace(workspaceFolders)) {
    return {
      status: 'no-folder',
      message: 'Open a local folder in this window to use Start This Folder.'
    };
  }
  const project = projectForCurrentWindow(projects, workspaceFolders, platform);
  if (!project) {
    return {
      status: 'no-project',
      message: "This window's folder is not a saved Runlist project. Add it from Runlist first."
    };
  }
  return {
    status: 'start',
    projectId: project.id
  };
}

function workspaceStartDevScripts(folder, readFileSync = fs.readFileSync) {
  if (typeof folder !== 'string' || !folder.trim()) {
    return [];
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const scripts = packageJson && typeof packageJson === 'object'
    ? packageJson.scripts
    : undefined;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return [];
  }
  const chips = [];
  for (const name of ['start', 'dev']) {
    if (typeof scripts[name] !== 'string' || !scripts[name].trim()) {
      continue;
    }
    chips.push({
      name,
      startCommand: name === 'start' ? 'npm start' : 'npm run dev'
    });
  }
  return chips;
}

async function selectCurrentWorkspaceFolder(vscode) {
  const workspaceFolders = localWorkspaceFolders(vscode.workspace.workspaceFolders);
  if (workspaceFolders.length === 0) {
    return undefined;
  }
  if (workspaceFolders.length === 1) {
    return workspaceFolders[0].uri.fsPath;
  }

  const selection = await vscode.window.showQuickPick(
    workspaceFolders.map((workspaceFolder) => ({
      description: workspaceFolder.uri.fsPath,
      folder: workspaceFolder.uri.fsPath,
      label: workspaceFolder.name
    })),
    {
      matchOnDescription: true,
      placeHolder: 'Choose the workspace folder to use for this project',
      title: 'Use current workspace'
    }
  );
  return selection?.folder;
}

module.exports = {
  canUseCurrentWorkspace,
  currentWorkspaceFolderPath,
  foldersReferToSamePath,
  localWorkspaceFolders,
  orderSidebarProjects,
  projectForCurrentWindow,
  projectLastStartedAt,
  selectCurrentWorkspaceFolder,
  startThisFolderDecision,
  starterDraftForCurrentWorkspace,
  workspaceFolderMatchesProject,
  workspaceStartDevScripts
};
