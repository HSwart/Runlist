const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeServiceUrl } = require('./external-url');

function initializeProjectStore(filePath, legacyProjects = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    writeProjects(filePath, Array.isArray(legacyProjects) ? legacyProjects : []);
  }
}

function migrateProjectStore(filePath, legacyFilePaths = []) {
  if (fs.existsSync(filePath)) {
    return [];
  }

  const stores = [];
  for (const legacyFilePath of legacyFilePaths) {
    if (!fs.existsSync(legacyFilePath)) {
      continue;
    }
    try {
      const projects = JSON.parse(fs.readFileSync(legacyFilePath, 'utf8'));
      if (!Array.isArray(projects)) {
        continue;
      }
      stores.push({
        filePath: legacyFilePath,
        modifiedAt: fs.statSync(legacyFilePath).mtimeMs,
        projects
      });
    } catch {
      // Leave an invalid preview store untouched and try the next known identity.
    }
  }

  if (!stores.length) {
    return [];
  }

  const projects = [];
  for (const store of stores.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
    for (const project of store.projects) {
      const folder = typeof project?.folder === 'string'
        ? normalizeForComparison(project.folder)
        : undefined;
      for (let index = projects.length - 1; index >= 0; index -= 1) {
        const existing = projects[index];
        const sameId = project?.id && existing?.id === project.id;
        const sameFolder = folder && typeof existing?.folder === 'string'
          && normalizeForComparison(existing.folder) === folder;
        if (sameId || sameFolder) {
          projects.splice(index, 1);
        }
      }
      projects.push(project);
    }
  }

  writeProjects(filePath, projects);
  return stores.map((store) => store.filePath);
}

function readProjects(filePath) {
  initializeProjectStore(filePath);
  const contents = fs.readFileSync(filePath, 'utf8');
  const projects = JSON.parse(contents);
  if (!Array.isArray(projects)) {
    throw new Error('Switchboard project storage is not a valid list.');
  }
  return projects;
}

function writeProjects(filePath, projects) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(projects, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, filePath);
}

function upsertProject(filePath, input, options = {}) {
  const folder = normalizeFolder(input.folder);
  const startCommand = normalizeCommand(input.startCommand, 'startCommand');
  const stopCommand = normalizeOptionalCommand(input.stopCommand, 'stopCommand');
  const providedServices = input.services === undefined
    ? undefined
    : normalizeServices(input.services);
  const projects = readProjects(filePath);
  const index = input.id
    ? projects.findIndex((project) => project.id === input.id)
    : projects.findIndex((project) => normalizeForComparison(project.folder) === folder);

  if (input.id && index === -1) {
    throw new Error('The Switchboard project being edited no longer exists.');
  }

  const existing = index >= 0 ? projects[index] : undefined;
  const name = input.name === undefined
    ? existing?.name || path.basename(folder)
    : normalizeProjectName(input.name, path.basename(folder));
  const project = {
    id: existing?.id || createId(),
    name,
    folder,
    startCommand,
    ...(stopCommand ? { stopCommand } : {}),
    services: providedServices || existing?.services || [],
    reviewRequired: options.reviewRequired === undefined
      ? Boolean(existing?.reviewRequired)
      : Boolean(options.reviewRequired)
  };

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
  migrateProjectStore,
  readProjects,
  removeProject,
  upsertProject,
  writeProjects
};
