const fs = require('fs');
const path = require('path');

const COMPOSE_FILE_NAMES = Object.freeze([
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml'
]);

class ComposeFileError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ComposeFileError';
    this.code = code;
  }
}

function detectComposeFiles(folderPath) {
  const folder = normalizeFolder(folderPath);
  if (!folder) {
    return [];
  }
  const found = [];
  for (const name of COMPOSE_FILE_NAMES) {
    const candidate = path.join(folder, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        found.push(candidate);
      }
    } catch {
      // Missing or inaccessible candidates are skipped.
    }
  }
  return found;
}

function resolveComposeFile(folderPath, preferredPath) {
  if (typeof preferredPath === 'string' && preferredPath.trim()) {
    const resolved = path.resolve(preferredPath.trim());
    try {
      if (!fs.statSync(resolved).isFile()) {
        throw composeError(
          'COMPOSE_NOT_FOUND',
          'That Compose path is not a file Runlist can read.'
        );
      }
    } catch (error) {
      if (error instanceof ComposeFileError) {
        throw error;
      }
      throw composeError(
        'COMPOSE_NOT_FOUND',
        'Runlist could not find that Compose file.',
        { cause: error }
      );
    }
    return resolved;
  }

  const detected = detectComposeFiles(folderPath);
  if (!detected.length) {
    throw composeError(
      'COMPOSE_NOT_FOUND',
      'No compose.yaml, compose.yml, docker-compose.yaml, or docker-compose.yml was found in this folder.'
    );
  }
  return detected[0];
}

function readComposeFile(filePath) {
  const resolved = path.resolve(filePath);
  let contents;
  try {
    contents = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw composeError(
      'COMPOSE_UNREADABLE',
      'Runlist could not read that Compose file.',
      { cause: error }
    );
  }
  if (Buffer.byteLength(contents, 'utf8') > 2 * 1024 * 1024) {
    throw composeError(
      'COMPOSE_TOO_LARGE',
      'This Compose file is larger than 2 MiB, so Runlist will not import it.'
    );
  }
  return { path: resolved, contents };
}

function normalizeFolder(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    return undefined;
  }
  return path.resolve(folderPath.trim());
}

function composeError(code, message, options) {
  return new ComposeFileError(code, message, options);
}

module.exports = {
  COMPOSE_FILE_NAMES,
  ComposeFileError,
  detectComposeFiles,
  readComposeFile,
  resolveComposeFile
};
