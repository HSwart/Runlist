function openProjectInNewWindow(vscode, folder) {
  return vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(folder),
    { forceNewWindow: true }
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

module.exports = {
  openProjectInNewWindow,
  openProjectTerminal,
  projectFolderIsAccessible
};
