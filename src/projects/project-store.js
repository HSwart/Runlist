const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { safeServiceUrl } = require('../services/external-url');
const { optionalPortVariableValidationMessage } = require('../ports/service-port-overrides');
const { normalizeProjectTags } = require('./project-tags');
const {
  DEFAULT_LAUNCH_PROFILE_ID,
  DEFAULT_LAUNCH_PROFILE_NAME,
  MAX_ALTERNATE_LAUNCH_PROFILES
} = require('./launch-profile');

const PROJECT_STORE_SCHEMA_VERSION = 5;
const ATOMIC_RENAME_MAX_ATTEMPTS = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 10;
const ATOMIC_RENAME_WAIT = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const STORE_LOCK_MAX_ATTEMPTS = 400;
const STORE_LOCK_RETRY_MS = 5;
const STORE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const HELD_STORE_LOCKS = new Set();
const UNSAFE_COMMAND_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CURRENT_PROCESS_IDENTITY = synchronousProcessIdentity(process.pid);

class ProjectStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProjectStoreError';
    this.code = code;
  }
}

function initializeProjectStore(filePath, legacyProjects = [], options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    if (!options.lockHeld) {
      return withProjectStoreLock(filePath, () => initializeProjectStore(
        filePath,
        legacyProjects,
        { lockHeld: true }
      ));
    }
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
  return loadProjects(filePath, options);
}

function readProjects(filePath) {
  return initializeProjectStore(filePath);
}

function loadProjects(filePath, options = {}) {
  const contents = fs.readFileSync(filePath, 'utf8');
  let document;
  try {
    document = parseProjectDocument(contents);
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === 'UNSUPPORTED_VERSION') {
      throw error;
    }
    if (!options.lockHeld) {
      return withProjectStoreLock(filePath, () => loadProjects(filePath, { lockHeld: true }));
    }
    return recoverProjects(filePath, contents, error);
  }
  const groups = pruneRunGroups(document.groups, document.projects);
  const hadEmptyGroups = groups.length !== (document.groups || []).length;
  if (document.legacy || document.migrated || hadEmptyGroups) {
    if (!options.lockHeld) {
      return withProjectStoreLock(filePath, () => loadProjects(filePath, { lockHeld: true }));
    }
    writeFileAtomically(`${filePath}.bak`, contents);
    writeFileAtomically(filePath, serializeProjectDocument(document.projects, {
      ...(groups.length ? { groups } : {})
    }));
  }
  return document.projects;
}

function writeProjects(filePath, projects, options = {}) {
  if (!options.lockHeld) {
    return withProjectStoreLock(filePath, () => writeProjects(filePath, projects, {
      ...options,
      lockHeld: true
    }));
  }
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

function withProjectStoreLock(filePath, operation) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.write-lock`;
  if (HELD_STORE_LOCKS.has(lockPath)) {
    return operation();
  }
  let acquired = false;
  let lockToken;
  for (let attempt = 0; attempt < STORE_LOCK_MAX_ATTEMPTS; attempt += 1) {
    let descriptor;
    try {
      lockToken = crypto.randomUUID();
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        processIdentity: CURRENT_PROCESS_IDENTITY,
        createdAt: Date.now(),
        token: lockToken
      }));
      fs.closeSync(descriptor);
      descriptor = undefined;
      acquired = true;
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const observed = storeLockObservation(lockPath);
      if (observed && removeObservedStoreLock(
        lockPath,
        observed,
        projectStoreLockRecordIsAbandoned
      )) {
        continue;
      }
      Atomics.wait(STORE_LOCK_WAIT, 0, 0, STORE_LOCK_RETRY_MS);
    }
  }
  if (!acquired) {
    throw projectStoreError(
      'STORE_BUSY',
      'Runlist project storage is busy in another VS Code window. Try again.'
    );
  }
  HELD_STORE_LOCKS.add(lockPath);
  try {
    return operation();
  } finally {
    HELD_STORE_LOCKS.delete(lockPath);
    const observed = storeLockObservation(lockPath);
    if (observed) {
      removeObservedStoreLock(
        lockPath,
        observed,
        (record) => record?.token === lockToken
      );
    }
  }
}

function projectStoreLockIsAbandoned(lockPath) {
  try {
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return projectStoreLockRecordIsAbandoned(record);
  } catch {
    return false;
  }
}

function projectStoreLockRecordIsAbandoned(record, options = {}) {
  if (!Number.isInteger(record?.pid) || record.pid <= 0) {
    return false;
  }
  const kill = options.kill || process.kill;
  try {
    kill(record.pid, 0);
  } catch (error) {
    return error.code === 'ESRCH';
  }
  if (typeof record.processIdentity === 'string') {
    const currentIdentity = record.pid === process.pid
      ? CURRENT_PROCESS_IDENTITY
      : (options.readProcessIdentity || synchronousProcessIdentity)(record.pid);
    return Boolean(currentIdentity && currentIdentity !== record.processIdentity);
  }
  return false;
}

function removeObservedStoreLock(lockPath, observed, canRemove) {
  const cleanupPath = `${lockPath}.cleanup`;
  let cleanupToken;
  let acquired = false;
  for (let attempt = 0; attempt < STORE_LOCK_MAX_ATTEMPTS; attempt += 1) {
    let descriptor;
    try {
      cleanupToken = crypto.randomUUID();
      descriptor = fs.openSync(cleanupPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        processIdentity: CURRENT_PROCESS_IDENTITY,
        token: cleanupToken
      }));
      fs.closeSync(descriptor);
      descriptor = undefined;
      acquired = true;
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        try {
          fs.unlinkSync(cleanupPath);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (projectStoreLockIsAbandoned(cleanupPath)) {
        try {
          fs.unlinkSync(cleanupPath);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
        continue;
      }
      Atomics.wait(STORE_LOCK_WAIT, 0, 0, STORE_LOCK_RETRY_MS);
    }
  }
  if (!acquired) {
    return false;
  }
  try {
    const current = storeLockObservation(lockPath);
    if (!sameStoreLockObservation(current, observed)) {
      return false;
    }
    let record;
    try {
      record = JSON.parse(current.contents);
    } catch {
      record = undefined;
    }
    if (!canRemove(record, lockPath)) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  } finally {
    const cleanup = storeLockObservation(cleanupPath);
    if (cleanup) {
      try {
        const record = JSON.parse(cleanup.contents);
        if (record.token === cleanupToken) {
          fs.unlinkSync(cleanupPath);
        }
      } catch {
        // Leave uncertain cleanup ownership in place rather than deleting another host's marker.
      }
    }
  }
}

function storeLockObservation(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      contents: fs.readFileSync(filePath, 'utf8'),
      device: stat.dev,
      inode: stat.ino,
      modifiedAt: stat.mtimeMs,
      size: stat.size
    };
  } catch {
    return undefined;
  }
}

function sameStoreLockObservation(left, right) {
  return Boolean(left && right
    && left.contents === right.contents
    && left.device === right.device
    && left.inode === right.inode
    && left.modifiedAt === right.modifiedAt
    && left.size === right.size);
}

function synchronousProcessIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      return fields[19] ? `${pid}:${fields[19]}` : undefined;
    }
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const startedAt = String(execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
      ], { encoding: 'utf8', windowsHide: true, timeout: 1000 })).trim();
      return startedAt ? `${pid}:${startedAt}` : undefined;
    }
    const startedAt = String(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 1000,
      windowsHide: true
    })).trim();
    return startedAt ? `${pid}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
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
  if (![1, 2, 3, 4, PROJECT_STORE_SCHEMA_VERSION].includes(value.schemaVersion)) {
    throw projectStoreError(
      'UNSUPPORTED_VERSION',
      `Runlist project storage version ${value.schemaVersion} is not supported.`
    );
  }
  if (Object.keys(value).some((key) => !['schemaVersion', 'projects', 'groups'].includes(key))) {
    throw projectStoreError('INVALID_STORAGE', 'Runlist project storage contains unsupported data.');
  }
  const projects = validateStoredProjects(value.projects, { schemaVersion: value.schemaVersion });
  return {
    legacy: false,
    schemaVersion: value.schemaVersion,
    migrated: value.schemaVersion !== PROJECT_STORE_SCHEMA_VERSION,
    projects,
    groups: value.groups === undefined
      ? []
      : validateRunGroups(value.groups, projects, { schemaVersion: value.schemaVersion })
  };
}

function validateRunGroups(value, projects, options = {}) {
  const supportsStartMode = options.schemaVersion === undefined || options.schemaVersion >= 4;
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
    const allowedKeys = ['id', 'name', 'projectIds', ...(supportsStartMode ? ['startMode'] : [])];
    if (Object.keys(group).some((key) => !allowedKeys.includes(key))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist group ${index + 1} contains unsupported data.`);
    }
    validateStoredText(group.id, `group ${index + 1} id`, 256);
    validateStoredText(group.name, `group ${index + 1} name`, 100);
    if (supportsStartMode
      && group.startMode !== undefined
      && !['sequential', 'parallel'].includes(group.startMode)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist group ${index + 1} has an invalid start mode.`);
    }
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
      projectIds: [...group.projectIds],
      startMode: supportsStartMode && group.startMode === 'parallel' ? 'parallel' : 'sequential'
    };
  });
}

function validateStoredProjects(value, options = {}) {
  const legacy = options.legacy === true;
  const supportsLaunchProfiles = options.schemaVersion === undefined
    || options.schemaVersion >= 2;
  const supportsHealthChecks = options.schemaVersion === undefined
    || options.schemaVersion >= 3;
  const supportsTags = options.schemaVersion === undefined || options.schemaVersion >= 5;
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
      ...(supportsLaunchProfiles ? ['launchProfiles', 'selectedLaunchProfileId'] : []),
      ...(supportsTags ? ['tags'] : []),
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
    validateStoredCommand(project.startCommand, `project ${index + 1} start command`, 4096);
    if (project.stopCommand !== undefined) {
      validateStoredCommand(project.stopCommand, `project ${index + 1} stop command`, 4096);
    }
    const services = project.services === undefined && legacy
      ? []
      : validateStoredServices(project.services, index, { supportsHealthChecks });
    const launchProfiles = supportsLaunchProfiles
      ? validateStoredLaunchProfiles(project.launchProfiles, index, { supportsHealthChecks })
      : [];
    if (supportsLaunchProfiles && project.selectedLaunchProfileId !== undefined) {
      validateStoredText(
        project.selectedLaunchProfileId,
        `project ${index + 1} selected launch profile id`,
        256
      );
      if (project.selectedLaunchProfileId !== DEFAULT_LAUNCH_PROFILE_ID
        && !launchProfiles.some((profile) => profile.id === project.selectedLaunchProfileId)) {
        throw projectStoreError(
          'INVALID_STORAGE',
          `Runlist project ${index + 1} has an invalid selected launch profile.`
        );
      }
    }
    const reviewRequired = project.reviewRequired === undefined && legacy
      ? false
      : project.reviewRequired;
    if (typeof reviewRequired !== 'boolean') {
      throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} has invalid review state.`);
    }
    if (project.pinned !== undefined && typeof project.pinned !== 'boolean') {
      throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} has invalid pin state.`);
    }
    let tags = [];
    if (supportsTags && project.tags !== undefined) {
      try {
        tags = normalizeProjectTags(project.tags);
      } catch {
        throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} has invalid tags.`);
      }
      if (JSON.stringify(tags) !== JSON.stringify(project.tags)) {
        throw projectStoreError('INVALID_STORAGE', `Runlist project ${index + 1} has invalid tags.`);
      }
    }

    const projectWithoutTags = { ...project };
    delete projectWithoutTags.tags;
    return {
      ...projectWithoutTags,
      services,
      ...(launchProfiles.length ? { launchProfiles } : {}),
      ...(tags.length ? { tags } : {}),
      reviewRequired
    };
  });
}

function validateStoredLaunchProfiles(value, projectIndex, options = {}) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_ALTERNATE_LAUNCH_PROFILES) {
    throw projectStoreError('INVALID_STORAGE', `Runlist project ${projectIndex + 1} launch profiles are not valid.`);
  }
  const ids = new Set([DEFAULT_LAUNCH_PROFILE_ID]);
  const names = new Set([DEFAULT_LAUNCH_PROFILE_NAME.toLocaleLowerCase()]);
  return value.map((profile, profileIndex) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist launch profile ${profileIndex + 1} is not valid.`);
    }
    if (Object.keys(profile).some((key) => !['id', 'name', 'startCommand', 'stopCommand', 'services'].includes(key))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist launch profile ${profileIndex + 1} contains unsupported data.`);
    }
    validateStoredText(profile.id, `launch profile ${profileIndex + 1} id`, 256);
    validateStoredText(profile.name, `launch profile ${profileIndex + 1} name`, 100);
    validateStoredCommand(profile.startCommand, `launch profile ${profileIndex + 1} start command`, 4096);
    if (profile.stopCommand !== undefined) {
      validateStoredCommand(profile.stopCommand, `launch profile ${profileIndex + 1} stop command`, 4096);
    }
    const normalizedName = profile.name.toLocaleLowerCase();
    if (ids.has(profile.id) || names.has(normalizedName)) {
      throw projectStoreError('INVALID_STORAGE', 'Runlist launch profiles must have unique names and identifiers.');
    }
    ids.add(profile.id);
    names.add(normalizedName);
    return {
      ...profile,
      services: validateStoredServices(profile.services, projectIndex, options)
    };
  });
}

function validateStoredText(value, label, maximumLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw projectStoreError('INVALID_STORAGE', `Runlist ${label} is not valid.`);
  }
}

function validateStoredCommand(value, label, maximumLength) {
  validateStoredText(value, label, maximumLength);
  if (UNSAFE_COMMAND_CONTROL_CHARACTERS.test(value)) {
    throw projectStoreError(
      'INVALID_STORAGE',
      `Runlist ${label} contains unsupported control characters.`
    );
  }
}

function validateStoredFolder(value, projectIndex) {
  validateStoredText(value, `project ${projectIndex + 1} folder`, 4096);
  if (!path.isAbsolute(value)) {
    throw projectStoreError('INVALID_STORAGE', `Runlist project ${projectIndex + 1} folder is not an absolute path.`);
  }
}

function validateStoredServices(value, projectIndex, options = {}) {
  if (!Array.isArray(value) || value.length > 32) {
    throw projectStoreError('INVALID_STORAGE', `Runlist project ${projectIndex + 1} services are not valid.`);
  }

  const names = new Set();
  const ports = new Set();
  const portVariables = new Set();
  return value.map((service, serviceIndex) => {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} is not valid.`);
    }
    const allowedKeys = [
      'name',
      'port',
      'portVariable',
      'url',
      ...(options.supportsHealthChecks ? ['healthCheck'] : [])
    ];
    if (Object.keys(service).some((key) => !allowedKeys.includes(key))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} contains unsupported data.`);
    }
    validateStoredText(service.name, `service ${serviceIndex + 1} name`, 64);
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid port.`);
    }
    if (service.url !== undefined && (typeof service.url !== 'string' || !safeServiceUrl(service.url))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid URL.`);
    }
    if (service.portVariable !== undefined
      && (typeof service.portVariable !== 'string'
        || optionalPortVariableValidationMessage(service.portVariable))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid port variable.`);
    }
    if (options.supportsHealthChecks && service.healthCheck !== undefined) {
      validateStoredHealthCheck(service.healthCheck, serviceIndex);
    }

    const normalizedName = service.name.toLowerCase();
    const normalizedVariable = service.portVariable?.toLocaleLowerCase('en-US');
    if (names.has(normalizedName) || ports.has(service.port)
      || (normalizedVariable && portVariables.has(normalizedVariable))) {
      throw projectStoreError('INVALID_STORAGE', 'Runlist project services must have unique names, ports, and port variables.');
    }
    names.add(normalizedName);
    ports.add(service.port);
    if (normalizedVariable) {
      portVariables.add(normalizedVariable);
    }
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
  const launchProfiles = input.launchProfiles === undefined
    ? (existing?.launchProfiles || []).map((profile) => ({
        ...profile,
        services: profile.services.map((service) => ({ ...service }))
      }))
    : normalizeLaunchProfiles(input.launchProfiles);
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
  const tags = input.tags === undefined
    ? normalizeProjectTags(existing?.tags)
    : normalizeProjectTags(input.tags);

  const selectedProfile = input.selectedLaunchProfileId === undefined
    ? existing?.selectedLaunchProfileId
    : input.selectedLaunchProfileId;
  if (selectedProfile !== undefined
    && selectedProfile !== DEFAULT_LAUNCH_PROFILE_ID
    && !launchProfiles.some((profile) => profile.id === selectedProfile)) {
    throw new Error('selectedLaunchProfileId must identify a saved launch profile.');
  }

  return {
    id,
    name,
    folder,
    startCommand,
    ...(stopCommand ? { stopCommand } : {}),
    services: providedServices || existing?.services || [],
    ...(launchProfiles.length ? { launchProfiles } : {}),
    ...(selectedProfile && selectedProfile !== DEFAULT_LAUNCH_PROFILE_ID
      ? { selectedLaunchProfileId: selectedProfile }
      : {}),
    ...(pinned ? { pinned: true } : {}),
    ...(tags.length ? { tags } : {}),
    reviewRequired: options.reviewRequired === undefined
      ? Boolean(existing?.reviewRequired)
      : Boolean(options.reviewRequired)
  };
}

function normalizeLaunchProfiles(value) {
  if (!Array.isArray(value) || value.length > MAX_ALTERNATE_LAUNCH_PROFILES) {
    throw new Error(`launchProfiles must contain no more than ${MAX_ALTERNATE_LAUNCH_PROFILES} alternate profiles.`);
  }
  const ids = new Set([DEFAULT_LAUNCH_PROFILE_ID]);
  const names = new Set([DEFAULT_LAUNCH_PROFILE_NAME.toLocaleLowerCase()]);
  return value.map((profile, index) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error(`launchProfiles[${index}] must be an object.`);
    }
    const unsupported = Object.keys(profile)
      .filter((key) => !['id', 'name', 'startCommand', 'stopCommand', 'services'].includes(key));
    if (unsupported.length) {
      throw new Error(`launchProfiles[${index}] has unsupported field: ${unsupported.join(', ')}`);
    }
    const id = profile.id || createId();
    validateStoredText(id, `launch profile ${index + 1} id`, 256);
    const name = normalizeProjectName(profile.name, '');
    if (!name) {
      throw new Error(`launchProfiles[${index}].name must contain 1 to 100 characters.`);
    }
    const normalizedName = name.toLocaleLowerCase();
    if (ids.has(id) || names.has(normalizedName)) {
      throw new Error('launch profile names and identifiers must be unique.');
    }
    ids.add(id);
    names.add(normalizedName);
    const startCommand = normalizeCommand(profile.startCommand, `launchProfiles[${index}].startCommand`);
    const stopCommand = normalizeOptionalCommand(profile.stopCommand, `launchProfiles[${index}].stopCommand`);
    return {
      id,
      name,
      startCommand,
      ...(stopCommand ? { stopCommand } : {}),
      services: normalizeServices(profile.services || [])
    };
  });
}

function validateStoredHealthCheck(value, serviceIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid health check.`);
  }
  if (Object.keys(value).some((key) => !['mode', 'target', 'method', 'expectedStatus', 'timeoutMs', 'retries'].includes(key))) {
    throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} health check contains unsupported data.`);
  }
  if (!['port', 'http'].includes(value.mode)) {
    throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid health check mode.`);
  }
  if (value.mode === 'port' && Object.keys(value).length !== 1) {
    throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has invalid port-only health settings.`);
  }
  if (value.mode === 'http') {
    if (value.target !== undefined
      && (typeof value.target !== 'string' || !validHealthTarget(value.target))) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid health target.`);
    }
    if (value.method !== undefined && !['HEAD', 'GET'].includes(value.method)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid health method.`);
    }
    if (value.expectedStatus !== undefined
      && (!Number.isInteger(value.expectedStatus) || value.expectedStatus < 100 || value.expectedStatus > 599)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid expected health status.`);
    }
    if (value.timeoutMs !== undefined
      && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 3000)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has an invalid health timeout.`);
    }
    if (value.retries !== undefined
      && (!Number.isInteger(value.retries) || value.retries < 0 || value.retries > 2)) {
      throw projectStoreError('INVALID_STORAGE', `Runlist service ${serviceIndex + 1} has invalid health retries.`);
    }
  }
}

function validHealthTarget(value) {
  const target = value.trim();
  const relativePath = target.startsWith('/') && !['/', '\\'].includes(target[1]);
  return Boolean(target) && (relativePath || Boolean(safeServiceUrl(target)));
}

function readRunGroups(filePath) {
  initializeProjectStore(filePath);
  return parseProjectDocument(fs.readFileSync(filePath, 'utf8')).groups || [];
}

function upsertRunGroup(filePath, input, options = {}) {
  return withProjectStoreLock(filePath, () => upsertRunGroupLocked(filePath, input, options));
}

function upsertRunGroupLocked(filePath, input, options = {}) {
  const projects = readProjects(filePath);
  const groups = readRunGroups(filePath);
  const index = input.id
    ? groups.findIndex((group) => group.id === input.id)
    : -1;
  if (input.id && index === -1) {
    throw new Error('The Runlist group being edited no longer exists.');
  }
  const existing = index >= 0 ? groups[index] : undefined;
  if (options.expectedGroup
    && JSON.stringify(existing) !== JSON.stringify(options.expectedGroup)) {
    throw projectStoreError(
      'STALE_GROUP',
      'This run group changed in another VS Code window. Reopen it before saving.'
    );
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
    projectIds,
    startMode: normalizeRunGroupStartMode(input.startMode ?? groups[index]?.startMode)
  };
  if (index >= 0) {
    groups[index] = group;
  } else {
    groups.push(group);
  }
  writeRunGroups(filePath, projects, groups, { lockHeld: true });
  return { action: index >= 0 ? 'updated' : 'created', group };
}

function removeRunGroup(filePath, id, options = {}) {
  return withProjectStoreLock(filePath, () => removeRunGroupLocked(filePath, id, options));
}

function removeRunGroupLocked(filePath, id, options = {}) {
  const projects = readProjects(filePath);
  const groups = readRunGroups(filePath);
  const existing = groups.find((group) => group.id === id);
  if (options.expectedGroup
    && JSON.stringify(existing) !== JSON.stringify(options.expectedGroup)) {
    throw projectStoreError(
      'STALE_GROUP',
      'This run group changed in another VS Code window. Reopen it before removing it.'
    );
  }
  const nextGroups = groups.filter((group) => group.id !== id);
  if (nextGroups.length === groups.length) {
    return false;
  }
  writeRunGroups(filePath, projects, nextGroups, { lockHeld: true });
  return true;
}

function writeRunGroups(filePath, projects, groups, options = {}) {
  if (!options.lockHeld) {
    return withProjectStoreLock(filePath, () => writeRunGroups(filePath, projects, groups, {
      lockHeld: true
    }));
  }
  const validatedGroups = validateRunGroups(groups, projects);
  const currentContents = fs.readFileSync(filePath, 'utf8');
  parseProjectDocument(currentContents);
  writeFileAtomically(`${filePath}.bak`, currentContents);
  writeFileAtomically(filePath, serializeProjectDocument(projects, { groups: validatedGroups }));
}

function pruneRunGroups(groups = [], projects) {
  const projectIds = new Set(projects.map((project) => project.id));
  return groups
    .map((group) => ({
      ...group,
      projectIds: group.projectIds.filter((projectId) => projectIds.has(projectId))
    }))
    .filter((group) => group.projectIds.length > 0);
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
  if (!options.lockHeld) {
    return withProjectStoreLock(filePath, () => upsertProject(filePath, input, {
      ...options,
      lockHeld: true
    }));
  }
  const folder = normalizeFolder(input.folder);
  const projects = readProjects(filePath);
  const index = input.id
    ? projects.findIndex((project) => project.id === input.id)
    : projects.findIndex((project) => normalizeForComparison(project.folder) === folder);

  if (input.id && index === -1) {
    throw new Error('The Runlist project being edited no longer exists.');
  }

  const existing = index >= 0 ? projects[index] : undefined;
  if (options.expectProjectAbsent && existing) {
    throw projectStoreError(
      'STALE_PROJECT',
      'This folder is already saved in Runlist. Open the existing project before changing its setup.'
    );
  }
  if (options.expectedProject
    && JSON.stringify(existing) !== JSON.stringify(options.expectedProject)) {
    throw projectStoreError(
      'STALE_PROJECT',
      'This project changed in another VS Code window. Reopen it before saving.'
    );
  }
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
  writeProjects(filePath, projects, { lockHeld: true });

  return {
    action: existing ? 'updated' : 'created',
    project
  };
}

function saveProjectSnapshot(filePath, input, options = {}) {
  const existingProject = options.existingProject;
  return upsertProject(filePath, input, {
    ...(existingProject
      ? { expectedProject: options.expectedProject }
      : { expectProjectAbsent: true }),
    reviewRequired: false
  });
}

function findProjectByFolder(filePath, folder) {
  const normalizedFolder = normalizeFolder(folder);
  return readProjects(filePath).find((project) => (
    normalizeForComparison(project.folder) === normalizedFolder
  ));
}

function removeProject(filePath, id, options = {}) {
  return withProjectStoreLock(filePath, () => removeProjectLocked(filePath, id, options));
}

function removeProjectLocked(filePath, id, options = {}) {
  const projects = readProjects(filePath);
  const existing = projects.find((project) => project.id === id);
  if (options.expectedProject
    && JSON.stringify(existing) !== JSON.stringify(options.expectedProject)) {
    throw projectStoreError(
      'STALE_PROJECT',
      'This project changed in another VS Code window. Reopen it before removing it.'
    );
  }
  const nextProjects = projects.filter((project) => project.id !== id);
  if (nextProjects.length === projects.length) {
    return false;
  }
  writeProjects(filePath, nextProjects, { lockHeld: true });
  return true;
}

function toggleProjectPinned(filePath, id) {
  return withProjectStoreLock(filePath, () => toggleProjectPinnedLocked(filePath, id));
}

function toggleProjectPinnedLocked(filePath, id) {
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
  writeProjects(filePath, projects, { lockHeld: true });
  return projects[index];
}

function normalizeRunGroupStartMode(value) {
  if (value === undefined || value === 'sequential') {
    return 'sequential';
  }
  if (value === 'parallel') {
    return 'parallel';
  }
  throw new Error('Run group start mode must be sequential or parallel.');
}

function selectProjectLaunchProfile(filePath, id, profileId) {
  return withProjectStoreLock(filePath, () => selectProjectLaunchProfileLocked(filePath, id, profileId));
}

function selectProjectLaunchProfileLocked(filePath, id, profileId) {
  const projects = readProjects(filePath);
  const index = projects.findIndex((project) => project.id === id);
  if (index === -1) {
    return undefined;
  }
  const profiles = projects[index].launchProfiles || [];
  if (profileId !== DEFAULT_LAUNCH_PROFILE_ID
    && !profiles.some((profile) => profile.id === profileId)) {
    throw new Error('The selected launch profile no longer exists.');
  }
  projects[index] = { ...projects[index] };
  if (profileId === DEFAULT_LAUNCH_PROFILE_ID) {
    delete projects[index].selectedLaunchProfileId;
  } else {
    projects[index].selectedLaunchProfileId = profileId;
  }
  writeProjects(filePath, projects, { lockHeld: true });
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
  if (UNSAFE_COMMAND_CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${fieldName} contains unsupported control characters.`);
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
  if (UNSAFE_COMMAND_CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${fieldName} contains unsupported control characters.`);
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
  const portVariables = new Set();
  return value.map((service, index) => {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw new Error(`services[${index}] must be an object.`);
    }
    const unsupportedKeys = Object.keys(service).filter((key) => !['name', 'port', 'portVariable', 'url', 'healthCheck'].includes(key));
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
    const portVariable = service.portVariable === undefined
      ? ''
      : typeof service.portVariable === 'string'
        ? service.portVariable.trim()
        : undefined;
    if (portVariable === undefined || optionalPortVariableValidationMessage(portVariable)) {
      throw new Error(`services[${index}].portVariable must be a portable, non-system environment variable name.`);
    }
    const healthCheck = normalizeHealthCheck(service.healthCheck, index);
    if (names.has(name.toLowerCase())) {
      throw new Error(`service names must be unique: ${name}.`);
    }
    if (ports.has(service.port)) {
      throw new Error(`service ports must be unique: ${service.port}.`);
    }
    const normalizedVariable = portVariable.toLocaleLowerCase('en-US');
    if (portVariable && portVariables.has(normalizedVariable)) {
      throw new Error(`service port variables must be unique: ${portVariable}.`);
    }

    names.add(name.toLowerCase());
    ports.add(service.port);
    if (portVariable) {
      portVariables.add(normalizedVariable);
    }
    return {
      name,
      port: service.port,
      ...(portVariable ? { portVariable } : {}),
      ...(url ? { url } : {}),
      ...(healthCheck ? { healthCheck } : {})
    };
  });
}

function normalizeHealthCheck(value, serviceIndex) {
  if (value === undefined || value === null || value === '' || value.mode === 'default') {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`services[${serviceIndex}].healthCheck must be an object.`);
  }
  if (value.mode === 'port') {
    return { mode: 'port' };
  }
  if (value.mode !== 'http') {
    throw new Error(`services[${serviceIndex}].healthCheck.mode must be port or http.`);
  }
  const target = value.target === undefined ? '' : String(value.target).trim();
  if (target && !validHealthTarget(target)) {
    throw new Error(`services[${serviceIndex}].healthCheck.target must be a safe HTTP URL or path beginning with /.`);
  }
  const method = value.method === undefined || value.method === '' ? 'HEAD' : value.method;
  if (!['HEAD', 'GET'].includes(method)) {
    throw new Error(`services[${serviceIndex}].healthCheck.method must be HEAD or GET.`);
  }
  const expectedStatus = value.expectedStatus === undefined || value.expectedStatus === ''
    ? undefined
    : Number(value.expectedStatus);
  if (expectedStatus !== undefined
    && (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) {
    throw new Error(`services[${serviceIndex}].healthCheck.expectedStatus must be an integer from 100 to 599.`);
  }
  const timeoutMs = value.timeoutMs === undefined || value.timeoutMs === ''
    ? 700
    : Number(value.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) {
    throw new Error(`services[${serviceIndex}].healthCheck.timeoutMs must be an integer from 100 to 3000.`);
  }
  const retries = value.retries === undefined || value.retries === '' ? 0 : Number(value.retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
    throw new Error(`services[${serviceIndex}].healthCheck.retries must be an integer from 0 to 2.`);
  }
  return {
    mode: 'http',
    ...(target ? { target } : {}),
    method,
    ...(expectedStatus === undefined ? {} : { expectedStatus }),
    timeoutMs,
    retries
  };
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
  projectStoreLockRecordIsAbandoned,
  readProjects,
  readRunGroups,
  removeProject,
  removeRunGroup,
  saveProjectSnapshot,
  serializeProjectDocument,
  selectProjectLaunchProfile,
  toggleProjectPinned,
  upsertProject,
  upsertRunGroup,
  withProjectStoreLock,
  writeFileAtomically,
  writeProjects
};
