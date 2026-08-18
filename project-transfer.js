const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  normalizeProjectInput,
  parseProjectDocument,
  ProjectStoreError,
  readProjects,
  serializeProjectDocument,
  writeProjects
} = require('./project-store');

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
  return document.projects;
}

function previewProjectImport(currentProjects, importedProjects, options = {}) {
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
      existing,
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

function applyProjectImport(filePath, preview) {
  const currentProjects = readProjects(filePath);
  if (projectListFingerprint(currentProjects) !== preview.fingerprint) {
    throw transferError(
      'STALE_IMPORT',
      'Runlist projects changed after the import preview. Review the file again.'
    );
  }
  writeProjects(filePath, preview.nextProjects);
  return preview.nextProjects;
}

async function runProjectTransferWorkflow(options) {
  const {
    isProjectActive,
    onImported,
    projectsFile,
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
        action: 'export-all',
        label: '$(export) Export all project setups',
        description: 'Save every project to a Runlist JSON file'
      },
      {
        action: 'export-one',
        label: '$(file) Export one project setup',
        description: 'Choose one saved project to export'
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
        window,
        workspace
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
    isProjectActive: options.isProjectActive
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

  const projects = applyProjectImport(options.projectsFile, preview);
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
    pinned: project.pinned === true
  });
}

function projectListFingerprint(projects) {
  return crypto.createHash('sha256').update(JSON.stringify(projects)).digest('hex');
}

function transferError(code, message, options) {
  return new ProjectTransferError(code, message, options);
}

module.exports = {
  applyProjectImport,
  exportProjectDocument,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_PROJECTS,
  parseImportDocument,
  previewProjectImport,
  ProjectTransferError,
  runProjectTransferWorkflow
};
