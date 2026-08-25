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
  return [
    ...projects.filter((project) => project.pinned === true),
    ...projects.filter((project) => project.pinned !== true && project.currentWorkspace === true),
    ...projects.filter((project) => project.pinned !== true && project.currentWorkspace !== true)
  ];
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
  selectCurrentWorkspaceFolder,
  startThisFolderDecision,
  starterDraftForCurrentWorkspace,
  workspaceFolderMatchesProject
};
