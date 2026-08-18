const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeServiceUrl } = require('./external-url');

const PROJECT_STORE_SCHEMA_VERSION = 1;
const ATOMIC_RENAME_MAX_ATTEMPTS = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 10;
const ATOMIC_RENAME_WAIT = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

class ProjectStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProjectStoreError';
    this.code = code;
  }
}

function initializeProjectStore(filePath, legacyProjects = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(`${filePath}.bak`)) {
      return recoverProjects(filePath);
    }
    const projects = validateStoredProjects(
      Array.isArray(legacyProjects) ? legacyProjects : [],
      { legacy: true }
    );
    writeFileAtomically(filePath, serializeProjectDocument(projects));
    return projects;
  }
  return loadProjects(filePath);
}

function readProjects(filePath) {
  return initializeProjectStore(filePath);
}

function loadProjects(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  let document;
  try {
    document = parseProjectDocument(contents);
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === 'UNSUPPORTED_VERSION') {
      throw error;
    }
    return recoverProjects(filePath, contents, error);
  }
  if (document.legacy) {
    writeFileAtomically(`${filePath}.bak`, contents);
    writeFileAtomically(filePath, serializeProjectDocument(document.projects));
  }
  return document.projects;
}

function writeProjects(filePath, projects) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const validatedProjects = validateStoredProjects(projects);
  let groups;
  if (fs.existsSync(filePath)) {
    const currentContents = fs.readFileSync(filePath, 'utf8');
    const currentDocument = parseProjectDocument(currentContents);
    groups = pruneRunGroups(currentDocument.groups, validatedProjects);
    writeFileAtomically(`${filePath}.bak`, currentContents);
  }
  writeFileAtomically(filePath, serializeProjectDocument(validatedProjects, {
    ...(groups?.length ? { groups } : {})
  }));
}

function recoverProjects(filePath, primaryContents, primaryError) {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) {
    throw unrecoverableStorageError(filePath, primaryError);
  }

  const backupContents = fs.readFileSync(backupPath, 'utf8');
  let backup;
  try {
    backup = parseProjectDocument(backupContents);
  } catch (backupError) {
    throw unrecoverableStorageError(filePath, primaryError, backupError);
  }

  if (primaryContents !== undefined) {
    writeFileAtomically(`${filePath}.corrupt`, primaryContents);
  }
  writeFileAtomically(
    filePath,
    backup.legacy ? serializeProjectDocument(backup.projects) : backupContents
  );
  return backup.projects;
}

function writeFileAtomically(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'w', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    renameFileAtomically(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

function renameFileAtomically(source, destination) {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (
        attempt === ATOMIC_RENAME_MAX_ATTEMPTS
        || !TRANSIENT_RENAME_ERROR_CODES.has(error?.code)
      ) {
        throw error;
      }
      Atomics.wait(ATOMIC_RENAME_WAIT, 0, 0, ATOMIC_RENAME_RETRY_DELAY_MS);
    }
  }
}

function serializeProjectDocument(projects, options = {}) {
  const document = {
    schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
    projects
  };
  if (options.groups !== undefined) {
    document.groups = validateRunGroups(options.groups, projects);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

function parseProjectDocument(contents) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw projectStoreError(
      'INVALID_STORAGE',
      'Runlist project storage is not valid JSON.',
      { cause: error }
    );
  }

  if (Array.isArray(value)) {
    return {
      legacy: true,
      projects: validateStoredProjects(value, { legacy: true })
    };
  }
  if (!value || typeof value !== 'object') {
    throw projectStoreError('INVALID_STORAGE', 'Runlist project storage is not a valid document.');
  }
  if (!Object.hasOwn(value, 'schemaVersion')) {
    throw projectStoreError('INVALID_STORAGE', 'Runlist project storage does not have a schema version.');
  }
  if (value.schemaVersion !== PROJECT_STORE_SCHEMA_VERSION) {
    throw projectStoreError(
      'UNSUPPORTED_VERSION',
      `Runlist project storage version ${value.schemaVersion} is not supported.`
    );
  }
  if (Object.keys(value).some((key) => !['schemaVersion', 'projects', 'groups'].includes(key))) {
    throw projectStoreError('INVALID_STORAGE', 'Runlist project storage contains unsupported data.');
  }
  const projects = validateStoredProjects(value.projects);
  return {
    legacy: false,
    projects,
    groups: value.groups === undefined ? [] : validateRunGroups(value.groups, projects)
  };
}

function validateRunGroups(value, projects) {
  if (!Array.isArray(value) || value.length > 32) {
    throw projectStoreError('INVALID_STORAGE', 'Runlist project storage does not contain a valid run group list.');
  }
  const groupIds = new Set();
  const names = new Set();
  const projectIds = new Set(projects.map((project) => project.id));
  return value.map((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist group ${index + 1} is not valid.`);
    }
    if (Object.keys(group).some((key) => !['id', 'name', 'projectIds'].includes(key))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist group ${index + 1} contains unsupported data.`);
    }
    validateStoredText(group.id, `group ${index + 1} id`, 256);
    validateStoredText(group.name, `group ${index + 1} name`, 100);
    if (!Array.isArray(group.projectIds) || group.projectIds.length > 20) {
      throw projectStoreError('INVALID_STORAGE', `Runlist group ${index + 1} project list is not valid.`);
    }
    const members = new Set();
    for (const projectId of group.projectIds) {
      validateStoredText(projectId, `group ${index + 1} project id`, 256);
      if (members.has(projectId) || !projectIds.has(projectId)) {
        throw projectStoreError('INVALID_STORAGE', `Runlist group ${index + 1} contains an invalid project.`);
      }
      members.add(projectId);
    }
    const normalizedName = group.name.toLocaleLowerCase();
    if (groupIds.has(group.id) || names.has(normalizedName)) {
      throw projectStoreError('INVALID_STORAGE', 'Runlist groups must have unique names and identifiers.');
    }
    groupIds.add(group.id);
    names.add(normalizedName);
    return {
      id: group.id,
      name: group.name,
      projectIds: [...group.projectIds]
    };
  });
}

function validateStoredProjects(value, options = {}) {
  const legacy = options.legacy === true;
  if (!Array.isArray(value)) {
    throw projectStoreError('INVALID_STORAGE', 'Runlist project storage does not contain a valid project list.');
  }

  const projectIds = new Set();
  const projectFolders = new Set();
  return value.map((project, index) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} is not valid.`);
    }
    const allowedKeys = new Set([
      'id',
      'name',
      'folder',
      'startCommand',
      'stopCommand',
      'services',
      'pinned',
      'reviewRequired'
    ]);
    if (Object.keys(project).some((key) => !allowedKeys.has(key))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} contains unsupported data.`);
    }

    validateStoredText(project.id, `project ${index + 1} id`, 256);
    validateStoredText(project.name, `project ${index + 1} name`, 4096);
    validateStoredFolder(project.folder, index);
    const comparableFolder = normalizeForComparison(project.folder);
    if (projectIds.has(project.id) || projectFolders.has(comparableFolder)) {
      throw projectStoreError(
        'INVALID_STORAGE',
        'Runlist projects must have unique identifiers and folders.'
      );
    }
    projectIds.add(project.id);
    projectFolders.add(comparableFolder);
    validateStoredText(project.startCommand, `project ${index + 1} start command`, 4096);
    if (project.stopCommand !== undefined) {
      validateStoredText(project.stopCommand, `project ${index + 1} stop command`, 4096);
    }
    const services = project.services === undefined && legacy
      ? []
      : validateStoredServices(project.services, index);
    const reviewRequired = project.reviewRequired === undefined && legacy
      ? false
      : project.reviewRequired;
    if (typeof reviewRequired !== 'boolean') {
      throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} has invalid review state.`);
    }
    if (project.pinned !== undefined && typeof project.pinned !== 'boolean') {
      throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} has invalid pin state.`);
    }

    return {
      ...project,
      services,
      reviewRequired
    };
  });
}

function validateStoredText(value, label, maximumLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw projectStoreError('INVALID_STORAGE', `Runlist ${label} is not valid.`);
  }
}

function validateStoredFolder(value, projectIndex) {
  validateStoredText(value, `project ${projectIndex + 1} folder`, 4096);
  if (!path.isAbsolute(value)) {
    throw projectStoreError('INVALID_STORAGE', `Runlist project ${projectIndex + 1} folder is not an absolute path.`);
  }
}

function validateStoredServices(value, projectIndex) {
  if (!Array.isArray(value) || value.length > 32) {
    throw projectStoreError('INVALID_STORAGE', `Runlist project ${projectIndex + 1} services are not valid.`);
  }

  const names = new Set();
  const ports = new Set();
  return value.map((service, serviceIndex) => {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} is not valid.`);
    }
    if (Object.keys(service).some((key) => !['name', 'port', 'url'].includes(key))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} contains unsupported data.`);
    }
    validateStoredText(service.name, `service ${serviceIndex + 1} name`, 64);
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid port.`);
    }
    if (service.url !== undefined && (typeof service.url !== 'string' || !safeServiceUrl(service.url))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid URL.`);
    }

    const normalizedName = service.name.toLowerCase();
    if (names.has(normalizedName) || ports.has(service.port)) {
      throw projectStoreError('INVALID_STORAGE', 'Runlist project services must have unique names and ports.');
    }
    names.add(normalizedName);
    ports.add(service.port);
    return { ...service };
  });
}

function projectStoreError(code, message, options) {
  return new ProjectStoreError(code, message, options);
}

function unrecoverableStorageError(filePath, primaryError, backupError) {
  const primaryName = path.basename(filePath);
  const backupName = path.basename(`${filePath}.bak`);
  return projectStoreError(
    'UNRECOVERABLE_STORAGE',
    `Runlist could not read ${primaryName} or ${backupName}. It did not overwrite either file.`,
    { cause: backupError || primaryError }
  );
}

function normalizeProjectInput(input, options = {}) {
  const existing = options.existing;
  const folder = options.normalizedFolder || normalizeFolder(input.folder);
  const startCommand = normalizeCommand(input.startCommand, 'startCommand');
  const stopCommand = normalizeOptionalCommand(input.stopCommand, 'stopCommand');
  const providedServices = input.services === undefined
    ? undefined
    : normalizeServices(input.services);
  const fallbackName = path.basename(folder);
  let name;
  if (input.name === undefined) {
    name = existing?.name || fallbackName;
  } else if (options.allowStoredName === true) {
    validateStoredText(input.name, 'project name', 4096);
    name = input.name;
  } else {
    name = normalizeProjectName(input.name, fallbackName);
  }
  const id = options.id || existing?.id || input.id || createId();
  validateStoredText(id, 'project id', 256);
  const pinned = input.pinned === undefined
    ? existing?.pinned === true
    : input.pinned === true;

  return {
    id,
    name,
    folder,
    startCommand,
    ...(stopCommand ? { stopCommand } : {}),
    services: providedServices || existing?.services || [],
    ...(pinned ? { pinned: true } : {}),
    reviewRequired: options.reviewRequired === undefined
      ? Boolean(existing?.reviewRequired)
      : Boolean(options.reviewRequired)
  };
}

function readRunGroups(filePath) {
  initializeProjectStore(filePath);
  return parseProjectDocument(fs.readFileSync(filePath, 'utf8')).groups || [];
}

function upsertRunGroup(filePath, input) {
  const projects = readProjects(filePath);
  const groups = readRunGroups(filePath);
  const index = input.id
    ? groups.findIndex((group) => group.id === input.id)
    : -1;
  if (input.id && index === -1) {
    throw new Error('The Runlist group being edited no longer exists.');
  }
  const name = normalizeRunGroupName(input.name);
  const projectIds = normalizeRunGroupProjects(input.projectIds, projects);
  const duplicateName = groups.find((group, groupIndex) => (
    groupIndex !== index && group.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  ));
  if (duplicateName) {
    throw new Error(`A run group named ${name} already exists.`);
  }
  const group = {
    id: input.id || createId(),
    name,
    projectIds
  };
  if (index >= 0) {
    groups[index] = group;
  } else {
    groups.push(group);
  }
  writeRunGroups(filePath, projects, groups);
  return { action: index >= 0 ? 'updated' : 'created', group };
}

function removeRunGroup(filePath, id) {
  const projects = readProjects(filePath);
  const groups = readRunGroups(filePath);
  const nextGroups = groups.filter((group) => group.id !== id);
  if (nextGroups.length === groups.length) {
    return false;
  }
  writeRunGroups(filePath, projects, nextGroups);
  return true;
}

function writeRunGroups(filePath, projects, groups) {
  const validatedGroups = validateRunGroups(groups, projects);
  const currentContents = fs.readFileSync(filePath, 'utf8');
  parseProjectDocument(currentContents);
  writeFileAtomically(`${filePath}.bak`, currentContents);
  writeFileAtomically(filePath, serializeProjectDocument(projects, { groups: validatedGroups }));
}

function pruneRunGroups(groups = [], projects) {
  const projectIds = new Set(projects.map((project) => project.id));
  return groups.map((group) => ({
    ...group,
    projectIds: group.projectIds.filter((projectId) => projectIds.has(projectId))
  }));
}

function normalizeRunGroupName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Run group name must contain 1 to 100 characters.');
  }
  const name = value.trim();
  if (name.length > 100) {
    throw new Error('Run group name must contain 1 to 100 characters.');
  }
  return name;
}

function normalizeRunGroupProjects(value, projects) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('A run group must contain 1 to 20 projects.');
  }
  const savedProjectIds = new Set(projects.map((project) => project.id));
  const projectIds = [];
  for (const projectId of value) {
    if (typeof projectId !== 'string' || !savedProjectIds.has(projectId) || projectIds.includes(projectId)) {
      throw new Error('A run group can contain each saved project once.');
    }
    projectIds.push(projectId);
  }
  return projectIds;
}

function upsertProject(filePath, input, options = {}) {
  const folder = normalizeFolder(input.folder);
  const projects = readProjects(filePath);
  const index = input.id
    ? projects.findIndex((project) => project.id === input.id)
    : projects.findIndex((project) => normalizeForComparison(project.folder) === folder);

  if (input.id && index === -1) {
    throw new Error('The Runlist project being edited no longer exists.');
  }

  const existing = index >= 0 ? projects[index] : undefined;
  const project = normalizeProjectInput(input, {
    allowStoredName: options.allowStoredName === true,
    existing,
    normalizedFolder: folder,
    reviewRequired: options.reviewRequired
  });

  if (existing) {
    projects[index] = project;
  } else {
    projects.push(project);
  }
  writeProjects(filePath, projects);

  return {
    action: existing ? 'updated' : 'created',
    project
  };
}

function findProjectByFolder(filePath, folder) {
  const normalizedFolder = normalizeFolder(folder);
  return readProjects(filePath).find((project) => (
    normalizeForComparison(project.folder) === normalizedFolder
  ));
}

function removeProject(filePath, id) {
  const projects = readProjects(filePath);
  const nextProjects = projects.filter((project) => project.id !== id);
  if (nextProjects.length === projects.length) {
    return false;
  }
  writeProjects(filePath, nextProjects);
  return true;
}

function toggleProjectPinned(filePath, id) {
  const projects = readProjects(filePath);
  const index = projects.findIndex((project) => project.id === id);
  if (index === -1) {
    return undefined;
  }

  const pinned = projects[index].pinned !== true;
  projects[index] = {
    ...projects[index],
    ...(pinned ? { pinned: true } : {})
  };
  if (!pinned) {
    delete projects[index].pinned;
  }
  writeProjects(filePath, projects);
  return projects[index];
}

function pinnedProjectsFirst(projects) {
  return [
    ...projects.filter((project) => project.pinned === true),
    ...projects.filter((project) => project.pinned !== true)
  ];
}

function normalizeProjectName(value, fallback) {
  if (typeof value !== 'string') {
    throw new Error('name must be text.');
  }
  const name = value.trim();
  if (!name) {
    return fallback;
  }
  if (name.length > 100) {
    throw new Error('name cannot contain more than 100 characters.');
  }
  return name;
}

function normalizeFolder(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('folder must be a non-empty path.');
  }
  if (value.length > 4096) {
    throw new Error('folder is too long.');
  }

  const expanded = value.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(expanded)) {
    throw new Error('folder must be an absolute path.');
  }
  if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
    throw new Error(`folder does not exist or is not a directory: ${expanded}`);
  }
  return fs.realpathSync(expanded);
}

function normalizeCommand(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty command.`);
  }
  if (value.length > 4096) {
    throw new Error(`${fieldName} is too long.`);
  }
  return value.trim();
}

function normalizeOptionalCommand(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be text.`);
  }
  if (!value.trim()) {
    return undefined;
  }
  if (value.length > 4096) {
    throw new Error(`${fieldName} is too long.`);
  }
  return value.trim();
}

function normalizeServices(value) {
  if (!Array.isArray(value)) {
    throw new Error('services must be a list.');
  }
  if (value.length > 32) {
    throw new Error('services cannot contain more than 32 entries.');
  }

  const names = new Set();
  const ports = new Set();
  return value.map((service, index) => {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw new Error(`services[${index}] must be an object.`);
    }
    const unsupportedKeys = Object.keys(service).filter((key) => !['name', 'port', 'url'].includes(key));
    if (unsupportedKeys.length) {
      throw new Error(`services[${index}] has unsupported field: ${unsupportedKeys.join(', ')}`);
    }

    const name = typeof service.name === 'string' ? service.name.trim() : '';
    if (!name || name.length > 64) {
      throw new Error(`services[${index}].name must contain 1 to 64 characters.`);
    }
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      throw new Error(`services[${index}].port must be an integer from 1 to 65535.`);
    }
    const url = service.url === undefined ? '' : typeof service.url === 'string' ? service.url.trim() : undefined;
    if (url === undefined || (url && !safeServiceUrl(url))) {
      throw new Error(`services[${index}].url must be a valid HTTP or HTTPS URL without credentials.`);
    }
    if (names.has(name.toLowerCase())) {
      throw new Error(`service names must be unique: ${name}.`);
    }
    if (ports.has(service.port)) {
      throw new Error(`service ports must be unique: ${service.port}.`);
    }

    names.add(name.toLowerCase());
    ports.add(service.port);
    return { name, port: service.port, ...(url ? { url } : {}) };
  });
}

function normalizeForComparison(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  findProjectByFolder,
  initializeProjectStore,
  normalizeProjectInput,
  parseProjectDocument,
  pinnedProjectsFirst,
  ProjectStoreError,
  readProjects,
  readRunGroups,
  removeProject,
  removeRunGroup,
  serializeProjectDocument,
  toggleProjectPinned,
  upsertProject,
  upsertRunGroup,
  writeProjects
};
