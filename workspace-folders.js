function localWorkspaceFolders(workspaceFolders = []) {
  return workspaceFolders.filter((folder) => (
    folder?.uri?.scheme === 'file' && typeof folder.uri.fsPath === 'string'
  ));
}

function hasLocalWorkspaceFolder(workspaceFolders) {
  return localWorkspaceFolders(workspaceFolders).length > 0;
}

function canUseCurrentWorkspace(mode, workspaceFolders) {
  return mode === 'add' && hasLocalWorkspaceFolder(workspaceFolders);
}

async function chooseCurrentWorkspaceFolder(vscode) {
  const folders = localWorkspaceFolders(vscode.workspace.workspaceFolders);
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  const selection = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      description: folder.uri.fsPath,
      folder,
      label: folder.name
    })),
    {
      matchOnDescription: true,
      placeHolder: 'Choose a workspace folder to use'
    }
  );
  return selection?.folder.uri.fsPath;
}

module.exports = {
  canUseCurrentWorkspace,
  chooseCurrentWorkspaceFolder,
  hasLocalWorkspaceFolder,
  localWorkspaceFolders
};
