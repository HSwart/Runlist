const fs = require('fs');
const os = require('os');
const path = require('path');

function initializeProjectStore(filePath, legacyProjects = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    writeProjects(filePath, Array.isArray(legacyProjects) ? legacyProjects : []);
  }
}

function readProjects(filePath) {
  initializeProjectStore(filePath);
  const contents = fs.readFileSync(filePath, 'utf8');
  const projects = JSON.parse(contents);
  if (!Array.isArray(projects)) {
    throw new Error('Porter project storage is not a valid list.');
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

function upsertProject(filePath, input) {
  const folder = normalizeFolder(input.folder);
  const startCommand = normalizeCommand(input.startCommand, 'startCommand');
  const stopCommand = normalizeCommand(input.stopCommand, 'stopCommand');
  const projects = readProjects(filePath);
  const index = input.id
    ? projects.findIndex((project) => project.id === input.id)
    : projects.findIndex((project) => normalizeForComparison(project.folder) === folder);

  if (input.id && index === -1) {
    throw new Error('The Porter project being edited no longer exists.');
  }

  const existing = index >= 0 ? projects[index] : undefined;
  const project = {
    id: existing?.id || createId(),
    name: path.basename(folder),
    folder,
    startCommand,
    stopCommand
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

function removeProject(filePath, id) {
  const projects = readProjects(filePath);
  const nextProjects = projects.filter((project) => project.id !== id);
  if (nextProjects.length === projects.length) {
    return false;
  }
  writeProjects(filePath, nextProjects);
  return true;
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
  initializeProjectStore,
  readProjects,
  removeProject,
  upsertProject,
  writeProjects
};
