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
  localWorkspaceFolders,
  selectCurrentWorkspaceFolder
};
