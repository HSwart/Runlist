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

function workspaceFolderChoices(workspaceFolders) {
  return localWorkspaceFolders(workspaceFolders).map((workspaceFolder) => ({
    name: workspaceFolder.name,
    folder: workspaceFolder.uri.fsPath
  }));
}

function resolveWorkspaceFolderPath(workspaceFolders, preferredFolder, platform = process.platform) {
  const folders = localWorkspaceFolders(workspaceFolders);
  if (!folders.length) {
    return undefined;
  }
  if (typeof preferredFolder === 'string' && preferredFolder.trim()) {
    const match = folders.find((workspaceFolder) => (
      foldersReferToSamePath(workspaceFolder.uri.fsPath, preferredFolder, platform)
    ));
    if (match) {
      return match.uri.fsPath;
    }
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

function starterDraftForCurrentWorkspace(workspaceFolders, preferredFolder) {
  const folder = resolveWorkspaceFolderPath(workspaceFolders, preferredFolder);
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
  if (Number.isFinite(project.lastStartedAt)) {
    latest = Math.max(latest, project.lastStartedAt);
  }
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

function workspacePackagePatterns(packageJson) {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((pattern) => typeof pattern === 'string' && pattern.trim());
  }
  if (workspaces && typeof workspaces === 'object' && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter((pattern) => typeof pattern === 'string' && pattern.trim());
  }
  return [];
}

function expandWorkspacePackageFolders(rootFolder, patterns, readdirSync = fs.readdirSync) {
  const folders = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = path.join(rootFolder, pattern.slice(0, -2));
      try {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            folders.add(path.join(base, entry.name));
          }
        }
      } catch {
        // Ignore unreadable workspace roots.
      }
      continue;
    }
    folders.add(path.join(rootFolder, pattern));
  }
  return [...folders];
}

function packageStartDevProposal(packageFolder, readFileSync = fs.readFileSync) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(packageFolder, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const scripts = packageJson && typeof packageJson === 'object'
    ? packageJson.scripts
    : undefined;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return undefined;
  }
  const name = typeof packageJson.name === 'string' && packageJson.name.trim()
    ? packageJson.name.trim()
    : path.basename(packageFolder);
  for (const scriptName of ['dev', 'start']) {
    if (typeof scripts[scriptName] !== 'string' || !scripts[scriptName].trim()) {
      continue;
    }
    return {
      folder: packageFolder,
      name,
      scriptName,
      startCommand: scriptName === 'start' ? 'npm start' : 'npm run dev'
    };
  }
  return undefined;
}

function discoverWorkspacePackageCandidates(rootFolder, options = {}) {
  if (typeof rootFolder !== 'string' || !rootFolder.trim()) {
    return [];
  }
  const readFileSync = options.readFileSync || fs.readFileSync;
  const readdirSync = options.readdirSync || fs.readdirSync;
  let rootPackage;
  try {
    rootPackage = JSON.parse(readFileSync(path.join(rootFolder, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const patterns = workspacePackagePatterns(rootPackage);
  if (!patterns.length) {
    return [];
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  return expandWorkspacePackageFolders(rootFolder, patterns, readdirSync)
    .map((folder) => packageStartDevProposal(folder, readFileSync))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit);
}

function workspaceStartDevScripts(folder, readFileSync = fs.readFileSync) {
  if (typeof folder !== 'string' || !folder.trim()) {
    return [];
  }
  const {
    classifyProjectRuntime,
    runtimeAllowsNpmStartChips
  } = require('./project-runtime');
  const runtime = classifyProjectRuntime(folder, { readFileSync });
  if (!runtimeAllowsNpmStartChips(runtime)) {
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

async function selectCurrentWorkspaceFolder(vscode, options = {}) {
  const workspaceFolders = localWorkspaceFolders(vscode.workspace.workspaceFolders);
  if (workspaceFolders.length === 0) {
    return undefined;
  }
  if (workspaceFolders.length === 1) {
    return workspaceFolders[0].uri.fsPath;
  }
  return resolveWorkspaceFolderPath(workspaceFolders, options.preferredFolder);
}

module.exports = {
  canUseCurrentWorkspace,
  currentWorkspaceFolderPath,
  discoverWorkspacePackageCandidates,
  foldersReferToSamePath,
  localWorkspaceFolders,
  orderSidebarProjects,
  projectForCurrentWindow,
  projectLastStartedAt,
  resolveWorkspaceFolderPath,
  selectCurrentWorkspaceFolder,
  startThisFolderDecision,
  starterDraftForCurrentWorkspace,
  workspaceFolderChoices,
  workspaceFolderMatchesProject,
  workspaceStartDevScripts
};
