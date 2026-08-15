function openProjectInNewWindow(vscode, folder) {
  return vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(folder),
    { forceNewWindow: true }
  );
}

module.exports = { openProjectInNewWindow };
