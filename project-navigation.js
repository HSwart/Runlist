function openProjectInNewWindow(vscode, folder) {
  return vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(folder),
    { forceNewWindow: true }
  );
}

function copyProjectPath(vscode, folder) {
  return vscode.env.clipboard.writeText(folder);
}

module.exports = { copyProjectPath, openProjectInNewWindow };
