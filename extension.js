const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { RunlistDiagnostics } = require('./src/lifecycle/runlist-diagnostics');
const {
  initializeProjectStore,
  ProjectStoreError,
  subscribeProjectStoreDiagnostics
} = require('./src/projects/project-store');
const { RunlistViewProvider } = require('./src/host/runlist-view-provider');
const { resolveRunlistHostRole } = require('./src/host/runlist-host-role');

const STORAGE_KEY = 'runlist.projects';

function installMcpBridge(context) {
  const storageRoot = context.globalStorageUri.fsPath;
  const mcpRoot = path.join(storageRoot, 'mcp');
  const serverPath = path.join(mcpRoot, 'server.js');
  const bridgeFiles = [
    'mcp/server.js',
    'src/lifecycle/atomic-json-record.js',
    'src/lifecycle/exclusive-json-lock.js',
    'src/lifecycle/process-identity.js',
    'src/lifecycle/process-lock.js',
    'src/lifecycle/process-metrics.js',
    'src/lifecycle/project-process.js',
    'src/lifecycle/runtime-process-owner.js',
    'src/ports/service-port-overrides.js',
    'src/projects/launch-env.js',
    'src/projects/launch-profile.js',
    'src/projects/project-output.js',
    'src/projects/project-diagnostics.js',
    'src/projects/project-repair.js',
    'src/projects/project-runtime.js',
    'src/projects/command-display.js',
    'src/projects/required-env.js',
    'src/projects/project-store.js',
    'src/projects/project-tags.js',
    'src/services/external-url.js',
    'src/services/local-hostname.js',
    'package.json'
  ];
  for (const relativePath of bridgeFiles) {
    const targetPath = path.join(storageRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(
      vscode.Uri.joinPath(context.extensionUri, ...relativePath.split('/')).fsPath,
      targetPath
    );
  }
  return serverPath;
}

let activeProvider;

function activate(context) {
  const hostRole = resolveRunlistHostRole({
    remoteName: vscode.env?.remoteName,
    extensionKind: context.extension?.extensionKind
  });
  if (!hostRole.activate) {
    return { hostRole };
  }

  const projectsFile = path.join(context.globalStorageUri.fsPath, 'projects.json');
  try {
    initializeProjectStore(projectsFile, context.globalState.get(STORAGE_KEY, []));
  } catch (error) {
    if (error instanceof ProjectStoreError) {
      void vscode.window.showErrorMessage(error.message);
    }
    throw error;
  }

  const serverPath = installMcpBridge(context);
  const diagnosticOutput = vscode.window.createOutputChannel('Runlist');
  const diagnostics = new RunlistDiagnostics({
    outputChannel: diagnosticOutput,
    traceEnabled: () => vscode.workspace
      .getConfiguration('runlist')
      .get('diagnostics.trace', false),
    environment: {
      runlistVersion: context.extension.packageJSON.version,
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      remoteKind: vscode.env.remoteName || 'local'
    }
  });
  const projectStoreDiagnostics = subscribeProjectStoreDiagnostics(
    projectsFile,
    (event, details) => diagnostics.record(`store.${event}`, details)
  );
  const provider = new RunlistViewProvider(context, projectsFile, serverPath, diagnostics);
  activeProvider = provider;
  context.subscriptions.push({ dispose: () => { void provider.dispose(); } });
  const handleProjectStoreChange = () => provider.handleProjectStoreChange();
  fs.watchFile(projectsFile, { interval: 500 }, handleProjectStoreChange);

  const mcpDefinition = new vscode.McpStdioServerDefinition(
    'Runlist',
    process.execPath,
    [serverPath],
    {
      ELECTRON_RUN_AS_NODE: '1',
      RUNLIST_PROJECTS_FILE: projectsFile
    },
    context.extension.packageJSON.version
  );
  mcpDefinition.cwd = context.globalStorageUri;

  context.subscriptions.push(
    diagnosticOutput,
    projectStoreDiagnostics,
    vscode.window.registerWebviewViewProvider('runlist.projects', provider),
    vscode.commands.registerCommand('runlist.addProject', () => provider.showAddProject()),
    vscode.commands.registerCommand('runlist.showAgentSetup', () => provider.showAgentSetup()),
    vscode.commands.registerCommand('runlist.transferProjects', () => provider.showProjectTransfer()),
    vscode.commands.registerCommand('runlist.manageGroups', () => provider.showRunGroupManager()),
    vscode.commands.registerCommand(
      'runlist.loadWorkspaceStack',
      () => provider.showProjectTransferLoadStack()
    ),
    vscode.commands.registerCommand(
      'runlist.showPortListening',
      () => provider.showPortListeningDiagnosis()
    ),
    vscode.commands.registerCommand(
      'runlist.importCompose',
      () => provider.showComposeImport()
    ),
    vscode.commands.registerCommand(
      'runlist.copySupportDiagnostics',
      () => provider.copySupportDiagnostics()
    ),
    vscode.commands.registerCommand('runlist.startThisFolder', () => provider.startThisFolder()),
    vscode.lm.registerMcpServerDefinitionProvider('runlist.projects', {
      provideMcpServerDefinitions: () => [mcpDefinition],
      resolveMcpServerDefinition: (server) => server
    }),
    provider.startStatusMonitoring(),
    { dispose: () => fs.unwatchFile(projectsFile, handleProjectStoreChange) }
  );

  const OPEN_TIP_KEY = 'runlist.didShowOpenTip';
  if (
    process.env.RUNLIST_EXTENSION_SMOKE !== '1'
    && !context.globalState.get(OPEN_TIP_KEY)
    && provider.projects.length === 0
  ) {
    void vscode.window.showInformationMessage(
      'Open Runlist to save and control local apps.',
      'Open Runlist'
    ).then(async (choice) => {
      await context.globalState.update(OPEN_TIP_KEY, true);
      if (choice === 'Open Runlist') {
        await provider.revealRunlistView();
      }
    });
  }

  if (process.env.RUNLIST_EXTENSION_SMOKE === '1') {
    return { projectsFile, provider };
  }
}

function deactivate() {
  const provider = activeProvider;
  activeProvider = undefined;
  return provider?.dispose();
}

module.exports = { activate, deactivate };
