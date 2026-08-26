const fs = require('fs');
const path = require('path');
const { normalizeEnvFile } = require('./launch-env');

const STACK_CONTRACT_SCHEMA_VERSION = 1;
const STACK_CONTRACT_FILE_CANDIDATES = Object.freeze([
  'runlist.json',
  path.join('.runlist', 'projects.json')
]);
const MAX_CONTRACT_BYTES = 5 * 1024 * 1024;
const MAX_CONTRACT_PROJECTS = 1000;
const FORBIDDEN_SECRET_KEYS = new Set([
  'env',
  'environment',
  'secrets',
  'secret',
  'password',
  'token',
  'apikey',
  'api_key',
  'credentials',
  'credential'
]);

class StackContractError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'StackContractError';
    this.code = code;
  }
}

function detectStackContract(workspaceRoot) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  for (const relative of STACK_CONTRACT_FILE_CANDIDATES) {
    const candidate = path.join(root, relative);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore transient filesystem errors and try the next candidate.
    }
  }
  return undefined;
}

function parseStackContract(contents, options = {}) {
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
  const text = Buffer.isBuffer(contents) || contents instanceof Uint8Array
    ? Buffer.from(contents).toString('utf8')
    : String(contents ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTRACT_BYTES) {
    throw stackError('TOO_LARGE', 'The Runlist stack file is larger than 5 MiB.');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw stackError('INVALID_CONTRACT', 'This is not a valid Runlist stack file.', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw stackError('INVALID_CONTRACT', 'This is not a valid Runlist stack file.');
  }
  rejectForbiddenKeys(value, 'stack file');
  const allowedTop = new Set(['schemaVersion', 'projects', 'groups']);
  if (Object.keys(value).some((key) => !allowedTop.has(key))) {
    throw stackError('INVALID_CONTRACT', 'The Runlist stack file contains unsupported fields.');
  }
  if (!Number.isInteger(value.schemaVersion)) {
    throw stackError('INVALID_CONTRACT', 'The Runlist stack file needs a schemaVersion.');
  }
  if (value.schemaVersion !== STACK_CONTRACT_SCHEMA_VERSION) {
    throw stackError(
      'UNSUPPORTED_VERSION',
      'This Runlist stack file uses an unsupported schema version.'
    );
  }
  if (!Array.isArray(value.projects)) {
    throw stackError('INVALID_CONTRACT', 'The Runlist stack file needs a projects list.');
  }
  if (value.projects.length > MAX_CONTRACT_PROJECTS) {
    throw stackError('TOO_LARGE', 'A Runlist stack file can contain at most 1,000 projects.');
  }

  const projects = value.projects.map((project, index) => (
    normalizeContractProject(project, index, workspaceRoot)
  ));
  const groups = value.groups === undefined
    ? []
    : normalizeContractGroups(value.groups, projects, workspaceRoot);

  return {
    schemaVersion: value.schemaVersion,
    projects,
    groups,
    contractPath: options.contractPath
  };
}

function serializeStackContract({ projects = [], groups = [] } = {}, options = {}) {
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
  const projectList = Array.isArray(projects) ? projects : [];
  const groupList = Array.isArray(groups) ? groups : [];
  const byId = new Map(projectList.map((project) => [project.id, project]));

  const serializedProjects = projectList.map((project) => {
    const folder = relativeWorkspaceFolder(project.folder, workspaceRoot);
    const entry = {
      name: project.name,
      folder,
      startCommand: project.startCommand,
      services: (project.services || []).map((service) => serializeContractService(service))
    };
    if (project.stopCommand) {
      entry.stopCommand = project.stopCommand;
    }
    if (Array.isArray(project.tags) && project.tags.length) {
      entry.tags = [...project.tags];
    }
    if (project.envFile) {
      entry.envFile = project.envFile;
    }
    if (Array.isArray(project.launchProfiles) && project.launchProfiles.length) {
      entry.launchProfiles = project.launchProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        startCommand: profile.startCommand,
        ...(profile.stopCommand ? { stopCommand: profile.stopCommand } : {}),
        ...(profile.envFile ? { envFile: profile.envFile } : {}),
        services: (profile.services || []).map((service) => serializeContractService(service))
      }));
    }
    return entry;
  });

  const serializedGroups = groupList.map((group) => {
    const projectFolders = (group.projectIds || []).map((projectId) => {
      const project = byId.get(projectId);
      if (!project) {
        throw stackError('INVALID_GROUP', `Run group "${group.name}" references a missing project.`);
      }
      return relativeWorkspaceFolder(project.folder, workspaceRoot);
    });
    return {
      name: group.name,
      projectFolders,
      startMode: group.startMode === 'parallel' ? 'parallel' : 'sequential'
    };
  });

  return `${JSON.stringify({
    schemaVersion: STACK_CONTRACT_SCHEMA_VERSION,
    projects: serializedProjects,
    groups: serializedGroups
  }, null, 2)}\n`;
}

function normalizeContractProject(project, index, workspaceRoot) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw stackError('INVALID_CONTRACT', `Stack project ${index + 1} is not valid.`);
  }
  rejectForbiddenKeys(project, `stack project ${index + 1}`);
  const allowed = new Set([
    'name',
    'folder',
    'startCommand',
    'stopCommand',
    'services',
    'tags',
    'launchProfiles',
    'envFile'
  ]);
  if (Object.keys(project).some((key) => !allowed.has(key))) {
    throw stackError('INVALID_CONTRACT', `Stack project ${index + 1} contains unsupported fields.`);
  }
  if (typeof project.name !== 'string' || !project.name.trim()) {
    throw stackError('INVALID_CONTRACT', `Stack project ${index + 1} needs a name.`);
  }
  if (typeof project.startCommand !== 'string' || !project.startCommand.trim()) {
    throw stackError('INVALID_CONTRACT', `Stack project ${index + 1} needs a startCommand.`);
  }

  const folder = resolveContractFolder(project.folder, workspaceRoot, `project ${index + 1}`);
  const services = normalizeContractServices(project.services, index);
  const entry = {
    name: project.name.trim(),
    folder,
    startCommand: project.startCommand.trim(),
    services
  };
  if (typeof project.stopCommand === 'string' && project.stopCommand.trim()) {
    entry.stopCommand = project.stopCommand.trim();
  }
  if (project.tags !== undefined) {
    if (!Array.isArray(project.tags) || project.tags.some((tag) => typeof tag !== 'string')) {
      throw stackError('INVALID_CONTRACT', `Stack project ${index + 1} has invalid tags.`);
    }
    entry.tags = project.tags.map((tag) => tag.trim()).filter(Boolean);
  }
  if (project.envFile !== undefined) {
    try {
      const envFile = normalizeEnvFile(project.envFile);
      if (!envFile) {
        throw new Error('empty');
      }
      entry.envFile = envFile;
    } catch {
      throw stackError(
        'INVALID_CONTRACT',
        `Stack project ${index + 1} has an invalid envFile path.`
      );
    }
  }
  if (project.launchProfiles !== undefined) {
    if (!Array.isArray(project.launchProfiles)) {
      throw stackError('INVALID_CONTRACT', `Stack project ${index + 1} has invalid launchProfiles.`);
    }
    entry.launchProfiles = project.launchProfiles.map((profile, profileIndex) => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw stackError(
          'INVALID_CONTRACT',
          `Stack project ${index + 1} launch profile ${profileIndex + 1} is not valid.`
        );
      }
      rejectForbiddenKeys(profile, `stack project ${index + 1} launch profile ${profileIndex + 1}`);
      const allowedProfile = new Set([
        'id',
        'name',
        'startCommand',
        'stopCommand',
        'services',
        'envFile'
      ]);
      if (Object.keys(profile).some((key) => !allowedProfile.has(key))) {
        throw stackError(
          'INVALID_CONTRACT',
          `Stack project ${index + 1} launch profile ${profileIndex + 1} contains unsupported fields.`
        );
      }
      let envFile;
      if (profile.envFile !== undefined) {
        try {
          envFile = normalizeEnvFile(profile.envFile);
          if (!envFile) {
            throw new Error('empty');
          }
        } catch {
          throw stackError(
            'INVALID_CONTRACT',
            `Stack project ${index + 1} launch profile ${profileIndex + 1} has an invalid envFile path.`
          );
        }
      }
      return {
        id: profile.id,
        name: profile.name,
        startCommand: profile.startCommand,
        ...(profile.stopCommand ? { stopCommand: profile.stopCommand } : {}),
        ...(envFile ? { envFile } : {}),
        services: normalizeContractServices(profile.services, index)
      };
    });
  }
  return entry;
}

function normalizeContractServices(services, projectIndex) {
  if (services === undefined) {
    return [];
  }
  if (!Array.isArray(services)) {
    throw stackError('INVALID_CONTRACT', `Stack project ${projectIndex + 1} services are not valid.`);
  }
  return services.map((service, serviceIndex) => {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw stackError(
        'INVALID_CONTRACT',
        `Stack project ${projectIndex + 1} service ${serviceIndex + 1} is not valid.`
      );
    }
    rejectForbiddenKeys(service, `stack project ${projectIndex + 1} service ${serviceIndex + 1}`);
    const allowed = new Set(['name', 'port', 'url', 'portVariable', 'healthCheck']);
    if (Object.keys(service).some((key) => !allowed.has(key))) {
      throw stackError(
        'INVALID_CONTRACT',
        `Stack project ${projectIndex + 1} service ${serviceIndex + 1} contains unsupported fields.`
      );
    }
    if (typeof service.name !== 'string' || !service.name.trim()) {
      throw stackError(
        'INVALID_CONTRACT',
        `Stack project ${projectIndex + 1} service ${serviceIndex + 1} needs a name.`
      );
    }
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      throw stackError(
        'INVALID_CONTRACT',
        `Stack project ${projectIndex + 1} service ${serviceIndex + 1} needs a port from 1 to 65535.`
      );
    }
    const normalized = {
      name: service.name.trim(),
      port: service.port
    };
    if (typeof service.url === 'string' && service.url.trim()) {
      normalized.url = service.url.trim();
    }
    if (typeof service.portVariable === 'string' && service.portVariable.trim()) {
      normalized.portVariable = service.portVariable.trim();
    }
    if (service.healthCheck && typeof service.healthCheck === 'object') {
      normalized.healthCheck = service.healthCheck;
    }
    return normalized;
  });
}

function normalizeContractGroups(groups, projects, workspaceRoot) {
  if (!Array.isArray(groups)) {
    throw stackError('INVALID_CONTRACT', 'The Runlist stack file groups list is not valid.');
  }
  if (groups.length > 32) {
    throw stackError('INVALID_CONTRACT', 'The Runlist stack file has too many groups.');
  }
  const folderSet = new Set(projects.map((project) => normalizePathKey(project.folder)));
  return groups.map((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw stackError('INVALID_CONTRACT', `Stack group ${index + 1} is not valid.`);
    }
    rejectForbiddenKeys(group, `stack group ${index + 1}`);
    const allowed = new Set(['name', 'projectFolders', 'startMode']);
    if (Object.keys(group).some((key) => !allowed.has(key))) {
      throw stackError('INVALID_CONTRACT', `Stack group ${index + 1} contains unsupported fields.`);
    }
    if (typeof group.name !== 'string' || !group.name.trim()) {
      throw stackError('INVALID_CONTRACT', `Stack group ${index + 1} needs a name.`);
    }
    if (!Array.isArray(group.projectFolders) || !group.projectFolders.length) {
      throw stackError('INVALID_CONTRACT', `Stack group ${index + 1} needs projectFolders.`);
    }
    if (group.startMode !== undefined && !['sequential', 'parallel'].includes(group.startMode)) {
      throw stackError('INVALID_CONTRACT', `Stack group ${index + 1} has an invalid startMode.`);
    }
    const projectFolders = group.projectFolders.map((folder, folderIndex) => {
      if (typeof folder !== 'string' || !folder.trim()) {
        throw stackError(
          'INVALID_CONTRACT',
          `Stack group ${index + 1} projectFolders[${folderIndex}] is not valid.`
        );
      }
      const absolute = resolveContractFolder(
        folder,
        workspaceRoot,
        `group ${index + 1} folder ${folderIndex + 1}`
      );
      if (!folderSet.has(normalizePathKey(absolute))) {
        throw stackError(
          'INVALID_CONTRACT',
          `Stack group ${index + 1} references a project folder that is not in the stack file.`
        );
      }
      return relativeWorkspaceFolder(absolute, workspaceRoot);
    });
    return {
      name: group.name.trim(),
      projectFolders,
      startMode: group.startMode === 'parallel' ? 'parallel' : 'sequential'
    };
  });
}

function serializeContractService(service) {
  const entry = {
    name: service.name,
    port: service.port
  };
  if (service.url) {
    entry.url = service.url;
  }
  if (service.portVariable) {
    entry.portVariable = service.portVariable;
  }
  if (service.healthCheck) {
    entry.healthCheck = service.healthCheck;
  }
  return entry;
}

function resolveContractFolder(folder, workspaceRoot, label) {
  if (typeof folder !== 'string' || !folder.trim()) {
    throw stackError('INVALID_CONTRACT', `Stack ${label} folder must be a relative path.`);
  }
  const trimmed = folder.trim().replace(/\\/g, '/');
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw stackError(
      'PATH_ESCAPE',
      `Stack ${label} folder must be relative to the workspace (absolute paths are not allowed).`
    );
  }
  if (trimmed.split('/').includes('..')) {
    throw stackError(
      'PATH_ESCAPE',
      `Stack ${label} folder must stay inside the workspace.`
    );
  }
  const resolved = path.resolve(workspaceRoot, trimmed);
  if (!isPathInsideWorkspace(resolved, workspaceRoot)) {
    throw stackError(
      'PATH_ESCAPE',
      `Stack ${label} folder must stay inside the workspace.`
    );
  }
  return resolved;
}

function relativeWorkspaceFolder(absoluteFolder, workspaceRoot) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const absolute = path.resolve(absoluteFolder);
  if (!isPathInsideWorkspace(absolute, root)) {
    throw stackError('PATH_ESCAPE', 'Saved project folders must stay inside the workspace to export.');
  }
  const relative = path.relative(root, absolute);
  if (!relative || relative === '') {
    return '.';
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw stackError('PATH_ESCAPE', 'Saved project folders must stay inside the workspace to export.');
  }
  return relative.split(path.sep).join('/');
}

function isPathInsideWorkspace(candidate, workspaceRoot) {
  const root = normalizePathKey(workspaceRoot);
  const target = normalizePathKey(candidate);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function normalizePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw stackError('INVALID_WORKSPACE', 'A workspace folder is required for the Runlist stack file.');
  }
  return path.resolve(workspaceRoot.trim());
}

function rejectForbiddenKeys(value, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      throw stackError(
        'SECRETS_FORBIDDEN',
        `The ${label} must not include secret values (${key}). Keep secrets out of the stack file.`
      );
    }
  }
}

function stackError(code, message, options) {
  return new StackContractError(code, message, options);
}

module.exports = {
  STACK_CONTRACT_FILE_CANDIDATES,
  STACK_CONTRACT_SCHEMA_VERSION,
  StackContractError,
  detectStackContract,
  parseStackContract,
  relativeWorkspaceFolder,
  resolveContractFolder,
  serializeStackContract
};
