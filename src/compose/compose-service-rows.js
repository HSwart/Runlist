const path = require('path');
const { detectComposeFiles, readComposeFile } = require('./compose-file');
const { parseComposeServices } = require('./compose-parse');
const { quoteShellArg } = require('./compose-runtime');

/**
 * Auto-detect a folder-root Compose file and build one normal Start/Stop row
 * per `services:` key. Existing saved projects in that folder stay as-is.
 * Rows are virtual (not persisted) because storage allows one project per folder.
 */

function buildComposeServiceRows(options = {}) {
  const folder = typeof options.folder === 'string' ? path.resolve(options.folder.trim()) : '';
  if (!folder) {
    return [];
  }
  const detected = detectComposeFiles(folder);
  if (!detected.length) {
    return [];
  }
  const composePath = detected[0];
  let parsed;
  try {
    const file = typeof options.contents === 'string'
      ? { path: composePath, contents: options.contents }
      : readComposeFile(composePath);
    parsed = parseComposeServices(file.contents, { composePath: file.path });
  } catch {
    return [];
  }

  const existingNames = new Set(
    (Array.isArray(options.existingProjects) ? options.existingProjects : [])
      .filter((project) => sameFolder(project.folder, folder))
      .map((project) => String(project.name || '').trim().toLowerCase())
      .filter(Boolean)
  );

  return parsed.services.map((service) => {
    const name = uniqueServiceName(service.name, existingNames);
    existingNames.add(name.toLowerCase());
    const fileArg = quoteShellArg(composePath);
    const serviceArg = quoteShellArg(service.name);
    const ports = Array.isArray(service.ports) ? service.ports : [];
    const row = {
      name,
      folder,
      startCommand: `docker compose -f ${fileArg} up --no-deps ${serviceArg}`,
      stopCommand: `docker compose -f ${fileArg} stop ${serviceArg}`,
      composePath,
      composeServices: [service.name],
      composeServiceName: service.name,
      composeAutoRow: true,
      composeNoDeps: true,
      services: ports.map((port) => ({
        name: ports.length > 1 ? `${service.name}:${port}` : service.name,
        port: String(port),
        url: '',
        composeService: service.name
      })),
      reviewRequired: false
    };
    return {
      ...row,
      id: createComposeRowId(row)
    };
  });
}

function mergeComposeAutoRows(projects = []) {
  const saved = (Array.isArray(projects) ? projects : []).filter((project) => !project?.composeAutoRow);
  const rows = [];
  for (const folder of uniqueFolders(saved)) {
    rows.push(...buildComposeServiceRows({
      folder,
      existingProjects: [...saved, ...rows]
    }));
  }
  return [...saved, ...rows];
}

function uniqueServiceName(serviceName, existingNames) {
  const base = String(serviceName || '').trim() || 'service';
  if (!existingNames.has(base.toLowerCase())) {
    return base;
  }
  let suffix = 2;
  while (suffix < 10000) {
    const candidate = `${base}-${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    suffix += 1;
  }
  return `${base}-${Date.now()}`;
}

function uniqueFolders(projects) {
  const seen = new Set();
  const folders = [];
  for (const project of projects) {
    const folder = typeof project?.folder === 'string' ? path.resolve(project.folder) : '';
    if (!folder || seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    folders.push(folder);
  }
  return folders;
}

function sameFolder(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

function createComposeRowId(row) {
  const crypto = require('crypto');
  const seed = `${row.composePath}::${row.composeServiceName}`;
  return `compose-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)}`;
}

function folderHasComposeFile(folder) {
  return detectComposeFiles(folder).length > 0;
}

module.exports = {
  buildComposeServiceRows,
  createComposeRowId,
  folderHasComposeFile,
  mergeComposeAutoRows,
  uniqueServiceName
};
