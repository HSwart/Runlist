const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  normalizeProjectInput,
  parseProjectDocument,
  ProjectStoreError,
  readProjects,
  readRunGroups,
  serializeProjectDocument,
  upsertRunGroup,
  withProjectStoreLock,
  writeProjects
} = require('./project-store');
const {
  StackContractError,
  detectStackContract,
  parseStackContract,
  serializeStackContract,
  resolveContractFolder
} = require('./stack-contract');

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_PROJECTS = 1000;

class ProjectTransferError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProjectTransferError';
    this.code = code;
  }
}

function exportProjectDocument(projects) {
  return serializeProjectDocument(projects);
}

function parseImportDocument(contents) {
  const text = Buffer.isBuffer(contents) || contents instanceof Uint8Array
    ? Buffer.from(contents).toString('utf8')
    : String(contents ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    throw transferError('IMPORT_TOO_LARGE', 'The Runlist import file is larger than 5 MiB.');
  }

  let document;
  try {
    document = parseProjectDocument(text);
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === 'UNSUPPORTED_VERSION') {
      throw transferError(
        'UNSUPPORTED_IMPORT_VERSION',
        'This Runlist import file uses an unsupported schema version.',
        { cause: error }
      );
    }
    throw transferError('INVALID_IMPORT', 'This is not a valid Runlist project export.', { cause: error });
  }
  if (document.legacy) {
    throw transferError(
      'UNSUPPORTED_IMPORT_FORMAT',
      'Legacy Runlist storage arrays cannot be imported. Export a versioned Runlist file first.'
    );
  }
  if (document.projects.length > MAX_IMPORT_PROJECTS) {
    throw transferError('IMPORT_TOO_LARGE', 'A Runlist import can contain at most 1,000 projects.');
  }
  Object.defineProperty(document.projects, 'schemaVersion', {
    value: document.schemaVersion,
    enumerable: false
  });
  return document.projects;
}

function previewProjectImport(currentProjects, importedProjects, options = {}) {
  const replaceOptionalMetadata = options.replaceOptionalMetadata
    ?? importedProjects.schemaVersion >= 5;
  const isProjectActive = typeof options.isProjectActive === 'function'
    ? options.isProjectActive
    : () => false;
  const currentByFolder = new Map(
    currentProjects.map((project) => [folderIdentity(project.folder), project])
  );
  const currentById = new Map(currentProjects.map((project) => [project.id, project]));
  const candidates = importedProjects.map((candidate) => {
    try {
      const normalized = normalizeProjectInput(candidate, {
        allowStoredName: true,
        reviewRequired: true
      });
      return {
        candidate,
        folder: folderIdentity(normalized.folder),
        id: normalized.id,
        normalized
      };
    } catch (error) {
      return { candidate, error };
    }
  });
  const repeatedFolders = repeatedValues(candidates.map((candidate) => candidate.folder));
  const repeatedIds = repeatedValues(candidates.map((candidate) => candidate.id));

  const entries = candidates.map((candidate) => {
    const name = candidate.candidate?.name || 'Unnamed project';
    const folder = candidate.candidate?.folder || '';
    if (candidate.error) {
      return invalidEntry(name, folder, candidate.error.message);
    }
    if (repeatedFolders.has(candidate.folder)) {
      return invalidEntry(name, folder, 'The import contains this repeated folder more than once.');
    }
    if (repeatedIds.has(candidate.id)) {
      return invalidEntry(name, folder, 'The import contains this repeated project identifier more than once.');
    }

    const existing = currentByFolder.get(candidate.folder);
    const idOwner = currentById.get(candidate.id);
    if (idOwner && idOwner !== existing) {
      return invalidEntry(name, folder, 'This project identifier already belongs to another saved folder.');
    }
    if (existing && isProjectActive(existing)) {
      return invalidEntry(name, folder, 'Stop this project before importing changes while it is running or changing state.');
    }

    const normalized = normalizeProjectInput(candidate.candidate, {
      allowStoredName: true,
      existing: replaceOptionalMetadata ? undefined : existing,
      id: existing?.id || candidate.id,
      normalizedFolder: candidate.normalized.folder,
      reviewRequired: true
    });
    if (existing && projectSetupFingerprint(existing) === projectSetupFingerprint(normalized)) {
      return {
        status: 'skip',
        name: existing.name,
        folder: existing.folder,
        project: existing,
        reason: 'The saved setup is unchanged.'
      };
    }
    return {
      status: existing ? 'update' : 'add',
      name: normalized.name,
      folder: normalized.folder,
      project: normalized
    };
  });

  const nextProjects = currentProjects.map((project) => ({ ...project }));
  const indexesById = new Map(nextProjects.map((project, index) => [project.id, index]));
  for (const entry of entries) {
    if (entry.status === 'update') {
      nextProjects[indexesById.get(entry.project.id)] = entry.project;
    } else if (entry.status === 'add') {
      indexesById.set(entry.project.id, nextProjects.length);
      nextProjects.push(entry.project);
    }
  }

  return {
    fingerprint: projectListFingerprint(currentProjects),
    entries,
    nextProjects,
    changeCount: entries.filter((entry) => ['add', 'update'].includes(entry.status)).length
  };
}

function applyProjectImport(filePath, preview, options = {}) {
  const updatedProjectIds = preview.entries
    .filter((entry) => entry.status === 'update')
    .map((entry) => entry.project.id);
  const reservation = updatedProjectIds.length && options.reserveUpdatedProjects
    ? options.reserveUpdatedProjects(updatedProjectIds)
    : undefined;
  if (reservation === false) {
    throw transferError(
      'ACTIVE_IMPORT',
      'A project changed state after the import preview. Stop it and review the file again.'
    );
  }

  try {
    return withProjectStoreLock(filePath, () => {
      const currentProjects = readProjects(filePath);
      if (projectListFingerprint(currentProjects) !== preview.fingerprint) {
        throw transferError(
          'STALE_IMPORT',
          'Runlist projects changed after the import preview. Review the file again.'
        );
      }
      writeProjects(filePath, preview.nextProjects, { lockHeld: true });
      return preview.nextProjects;
    });
  } finally {
    if (typeof reservation === 'function') {
      reservation();
    }
  }
}

async function runProjectTransferWorkflow(options) {
  const {
    isProjectActive,
    onImported,
    projectsFile,
    reserveUpdatedProjects,
    window,
    workspace
  } = options;
  try {
    const choice = await window.showQuickPick([
      {
        action: 'import',
        label: '$(cloud-download) Import project setups',
        description: 'Review a Runlist JSON file before saving it'
      },
      {
        action: 'load-stack',
        label: '$(repo) Load stack from this workspace',
        description: 'Review runlist.json before saving setups'
      },
      {
        action: 'export-all',
        label: '$(export) Export all project setups',
        description: 'Save every project to a Runlist JSON file'
      },
      {
        action: 'export-one',
        label: '$(file) Export one project setup',
        description: 'Choose one saved project to export'
      },
      {
        action: 'export-stack',
        label: '$(repo-push) Export setups to workspace stack file',
        description: 'Write relative paths to runlist.json'
      }
    ], {
      title: 'Import or Export Projects',
      placeHolder: 'Choose an action'
    });
    if (!choice) {
      return { status: 'cancelled' };
    }
    if (choice.action === 'import') {
      return await importProjects({
        isProjectActive,
        onImported,
        projectsFile,
        reserveUpdatedProjects,
        window,
        workspace
      });
    }
    if (choice.action === 'load-stack') {
      return await runStackContractLoadWorkflow({
        isProjectActive,
        onImported,
        projectsFile,
        reserveUpdatedProjects,
        window,
        workspaceRoot: options.workspaceRoot,
        withProjectStoreLock: options.withProjectStoreLock
      });
    }
    if (choice.action === 'export-stack') {
      return await runStackContractExportWorkflow({
        projectsFile,
        window,
        workspaceRoot: options.workspaceRoot
      });
    }
    return await exportProjects({
      action: choice.action,
      projectsFile,
      window,
      workspace
    });
  } catch (error) {
    await window.showErrorMessage(`Could not transfer Runlist projects: ${boundedMessage(error)}`);
    return { status: 'error', error };
  }
}

async function exportProjects(options) {
  const projects = readProjects(options.projectsFile);
  if (!projects.length) {
    await options.window.showInformationMessage('Runlist does not have any project setups to export.');
    return { status: 'empty' };
  }

  let selectedProjects = projects;
  if (options.action === 'export-one') {
    const selection = await options.window.showQuickPick(
      projects.map((project) => ({
        label: project.name,
        description: project.folder,
        project
      })),
      {
        title: 'Export One Project Setup',
        placeHolder: 'Choose a project'
      }
    );
    if (!selection) {
      return { status: 'cancelled' };
    }
    selectedProjects = [selection.project];
  }

  const target = await options.window.showSaveDialog({
    title: selectedProjects.length === 1
      ? `Export ${selectedProjects[0].name}`
      : 'Export All Runlist Projects',
    saveLabel: 'Export',
    filters: { JSON: ['json'] }
  });
  if (!target) {
    return { status: 'cancelled' };
  }
  await options.workspace.fs.writeFile(
    target,
    Buffer.from(exportProjectDocument(selectedProjects), 'utf8')
  );
  const label = `${selectedProjects.length} project setup${selectedProjects.length === 1 ? '' : 's'}`;
  await options.window.showInformationMessage(`Exported ${label}. Saved commands are included in the file.`);
  return { status: 'exported', count: selectedProjects.length };
}

async function importProjects(options) {
  const selection = await options.window.showOpenDialog({
    title: 'Import Runlist Project Setups',
    openLabel: 'Review Import',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ['json'] }
  });
  if (!selection?.length) {
    return { status: 'cancelled' };
  }
  const contents = await options.workspace.fs.readFile(selection[0]);
  const importedProjects = parseImportDocument(contents);
  const preview = previewProjectImport(readProjects(options.projectsFile), importedProjects, {
    isProjectActive: options.isProjectActive,
    replaceOptionalMetadata: importedProjects.schemaVersion >= 5
  });
  const detail = formatProjectImportPreview(preview.entries);
  if (!preview.changeCount) {
    await options.window.showInformationMessage(
      'Nothing can be imported from this file.',
      { modal: true, detail }
    );
    return { status: 'unchanged', preview };
  }

  const label = `${preview.changeCount} project setup${preview.changeCount === 1 ? '' : 's'}`;
  const confirm = `Import ${label}`;
  const approved = await options.window.showWarningMessage(
    `Import ${label}?`,
    {
      modal: true,
      detail: `${detail}\n\nAdded and updated commands remain blocked until you review and approve each setup in Runlist.`
    },
    confirm
  );
  if (approved !== confirm) {
    return { status: 'cancelled', preview };
  }

  const applyImport = () => applyProjectImport(options.projectsFile, preview, {
    reserveUpdatedProjects: options.reserveUpdatedProjects
  });
  const projects = options.withProjectStoreLock
    ? await options.withProjectStoreLock(applyImport)
    : applyImport();
  await options.onImported?.(projects);
  await options.window.showInformationMessage(
    `Imported ${label}. Review each changed setup before running its commands.`
  );
  return { status: 'imported', count: preview.changeCount, preview };
}

function formatProjectImportPreview(entries) {
  const groups = [
    ['add', 'Add'],
    ['update', 'Update'],
    ['skip', 'Skip'],
    ['invalid', 'Invalid']
  ];
  return groups.map(([status, label]) => {
    const matches = entries.filter((entry) => entry.status === status);
    if (!matches.length) {
      return `${label} (0)`;
    }
    const visible = matches.slice(0, 25).map((entry) => {
      const reason = entry.reason ? ` — ${entry.reason}` : '';
      return `• ${entry.name} — ${entry.folder}${reason}`;
    });
    if (matches.length > visible.length) {
      visible.push(`• …and ${matches.length - visible.length} more`);
    }
    return `${label} (${matches.length})\n${visible.join('\n')}`;
  }).join('\n\n');
}

function boundedMessage(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function invalidEntry(name, folder, reason) {
  return { status: 'invalid', name, folder, reason };
}

function repeatedValues(values) {
  const counts = new Map();
  for (const value of values) {
    if (value !== undefined) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function folderIdentity(folder) {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

function projectSetupFingerprint(project) {
  return JSON.stringify({
    name: project.name,
    folder: folderIdentity(project.folder),
    startCommand: project.startCommand,
    stopCommand: project.stopCommand || '',
    services: project.services || [],
    launchProfiles: project.launchProfiles || [],
    selectedLaunchProfileId: project.selectedLaunchProfileId || 'default',
    tags: project.tags || [],
    pinned: project.pinned === true,
    localHostname: project.localHostname || ''
  });
}

function projectListFingerprint(projects) {
  return crypto.createHash('sha256').update(JSON.stringify(projects)).digest('hex');
}

function transferError(code, message, options) {
  return new ProjectTransferError(code, message, options);
}

async function runStackContractLoadWorkflow(options) {
  const {
    isProjectActive,
    onImported,
    projectsFile,
    reserveUpdatedProjects,
    window,
    workspaceRoot,
    withProjectStoreLock
  } = options;
  try {
    if (!workspaceRoot) {
      await window.showErrorMessage(
        'Open a folder in VS Code to load a Runlist stack file from this workspace.'
      );
      return { status: 'error' };
    }
    const contractPath = detectStackContract(workspaceRoot);
    if (!contractPath) {
      await window.showInformationMessage(
        'No Runlist stack file found. Expected runlist.json or .runlist/projects.json in this workspace.'
      );
      return { status: 'missing' };
    }
    const contents = fs.readFileSync(contractPath);
    const parsed = parseStackContract(contents, {
      workspaceRoot,
      contractPath
    });
    const preview = previewProjectImport(readProjects(projectsFile), parsed.projects, {
      isProjectActive,
      replaceOptionalMetadata: false
    });
    const groupDetail = formatContractGroupPreview(parsed.groups);
    const detail = [formatProjectImportPreview(preview.entries), groupDetail]
      .filter(Boolean)
      .join('\n\n');
    if (!preview.changeCount) {
      await window.showInformationMessage(
        'Nothing new to load from the Runlist stack file.',
        { modal: true, detail }
      );
      return { status: 'unchanged', preview };
    }

    const label = `${preview.changeCount} project setup${preview.changeCount === 1 ? '' : 's'}`;
    const confirm = `Load ${label}`;
    const approved = await window.showWarningMessage(
      `Load ${label} from the workspace stack file?`,
      {
        modal: true,
        detail: `${detail}\n\nAdded and updated commands remain blocked until you review and approve each setup in Runlist.`
      },
      confirm
    );
    if (approved !== confirm) {
      return { status: 'cancelled', preview };
    }

    const applyImport = () => {
      const projects = applyProjectImport(projectsFile, preview, {
        reserveUpdatedProjects
      });
      syncRunGroupsFromContract(projectsFile, projects, parsed.groups, workspaceRoot);
      return projects;
    };
    const projects = withProjectStoreLock
      ? await withProjectStoreLock(applyImport)
      : applyImport();
    await onImported?.(projects);
    await window.showInformationMessage(
      `Loaded ${label}. Review each changed setup before running its commands.`
    );
    return { status: 'imported', count: preview.changeCount, preview };
  } catch (error) {
    const message = error instanceof StackContractError || error instanceof ProjectTransferError
      ? error.message
      : boundedMessage(error);
    await window.showErrorMessage(message);
    return { status: 'error', error };
  }
}

async function runStackContractExportWorkflow(options) {
  const { projectsFile, window, workspaceRoot } = options;
  try {
    if (!workspaceRoot) {
      await window.showErrorMessage(
        'Open a folder in VS Code to export a Runlist stack file into this workspace.'
      );
      return { status: 'error' };
    }
    const allProjects = readProjects(projectsFile);
    const exportable = allProjects.filter((project) => {
      try {
        serializeStackContract({ projects: [project], groups: [] }, { workspaceRoot });
        return true;
      } catch {
        return false;
      }
    });
    if (!exportable.length) {
      await window.showInformationMessage(
        'No saved setups are inside this workspace folder to export.'
      );
      return { status: 'empty' };
    }
    const exportableIds = new Set(exportable.map((project) => project.id));
    const groups = readRunGroups(projectsFile).filter((group) => (
      group.projectIds.every((id) => exportableIds.has(id))
    ));
    const existingPath = detectStackContract(workspaceRoot);
    const targetPath = existingPath || path.join(workspaceRoot, 'runlist.json');
    if (fs.existsSync(targetPath)) {
      const overwrite = 'Overwrite stack file';
      const approved = await window.showWarningMessage(
        `Overwrite ${path.basename(targetPath)} with the current reviewed setups?`,
        {
          modal: true,
          detail: 'Relative folders and commands will be written. Secret values are not included.'
        },
        overwrite
      );
      if (approved !== overwrite) {
        return { status: 'cancelled' };
      }
    }
    const document = serializeStackContract({
      projects: exportable,
      groups
    }, { workspaceRoot });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, document, 'utf8');
    const skipped = allProjects.length - exportable.length;
    const skipNote = skipped
      ? ` Skipped ${skipped} setup${skipped === 1 ? '' : 's'} outside this workspace.`
      : '';
    await window.showInformationMessage(
      `Exported ${exportable.length} project setup${exportable.length === 1 ? '' : 's'} to ${path.basename(targetPath)}.${skipNote}`
    );
    return { status: 'exported', count: exportable.length, path: targetPath };
  } catch (error) {
    const message = error instanceof StackContractError
      ? error.message
      : boundedMessage(error);
    await window.showErrorMessage(`Could not export the Runlist stack file: ${message}`);
    return { status: 'error', error };
  }
}

function syncRunGroupsFromContract(projectsFile, projects, contractGroups, workspaceRoot) {
  if (!Array.isArray(contractGroups) || !contractGroups.length) {
    return;
  }
  const byFolder = new Map(
    projects.map((project) => [folderIdentity(project.folder), project.id])
  );
  const existing = readRunGroups(projectsFile);
  for (const group of contractGroups) {
    const projectIds = [];
    for (const relativeFolder of group.projectFolders) {
      const absolute = resolveContractFolder(relativeFolder, workspaceRoot, 'group');
      const projectId = byFolder.get(folderIdentity(absolute));
      if (projectId) {
        projectIds.push(projectId);
      }
    }
    if (!projectIds.length) {
      continue;
    }
    const match = existing.find((entry) => (
      entry.name.toLocaleLowerCase() === group.name.toLocaleLowerCase()
    ));
    upsertRunGroup(projectsFile, {
      ...(match ? { id: match.id } : {}),
      name: group.name,
      projectIds,
      startMode: group.startMode
    });
  }
}

function formatContractGroupPreview(groups) {
  if (!groups?.length) {
    return '';
  }
  const lines = groups.slice(0, 25).map((group) => (
    `• ${group.name} — ${group.projectFolders.join(', ')} (${group.startMode})`
  ));
  if (groups.length > lines.length) {
    lines.push(`• …and ${groups.length - lines.length} more`);
  }
  return `Groups (${groups.length})\n${lines.join('\n')}`;
}

module.exports = {
  applyProjectImport,
  exportProjectDocument,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_PROJECTS,
  parseImportDocument,
  previewProjectImport,
  ProjectTransferError,
  runProjectTransferWorkflow,
  runStackContractExportWorkflow,
  runStackContractLoadWorkflow
};
