const fs = require('fs');
const path = require('path');
const { projectLaunchEnvironment } = require('../ports/service-port-overrides');

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_FILE_CHARS = 256;
const MAX_ENV_KEYS = 200;
const MAX_ENV_VALUE_CHARS = 8192;
const MAX_ENV_FILE_BYTES = 512 * 1024;

class LaunchEnvError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LaunchEnvError';
    this.code = code;
  }
}

function envFileValidationMessage(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return undefined;
  }
  try {
    normalizeEnvFile(text);
    return undefined;
  } catch (error) {
    return error.message;
  }
}

function envMapTextValidationMessage(value) {
  const text = String(value ?? '');
  if (!text.trim()) {
    return undefined;
  }
  try {
    parseEnvMapText(text);
    return undefined;
  } catch (error) {
    return error.message;
  }
}

function normalizeEnvFile(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Env file path must be text.');
  }
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_ENV_FILE_CHARS) {
    throw new Error(`Env file path cannot contain more than ${MAX_ENV_FILE_CHARS} characters.`);
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:\//.test(trimmed)) {
    throw new Error('Env file path must be relative to the project folder.');
  }
  const segments = trimmed.split('/').filter((segment) => segment && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) {
    throw new Error('Env file path must stay inside the project folder.');
  }
  return segments.join('/');
}

function normalizeEnvMap(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Env map must be an object of KEY=value pairs.');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_ENV_KEYS) {
    throw new Error(`Env map cannot contain more than ${MAX_ENV_KEYS} entries.`);
  }
  const normalized = {};
  for (const key of keys) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error('Env map keys must be valid environment variable names.');
    }
    if (typeof value[key] !== 'string') {
      throw new Error('Env map values must be text.');
    }
    if (value[key].length > MAX_ENV_VALUE_CHARS) {
      throw new Error(`Env map values cannot contain more than ${MAX_ENV_VALUE_CHARS} characters.`);
    }
    normalized[key] = value[key];
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function parseEnvMapText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const map = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      throw new Error('Env map lines must use KEY=value format.');
    }
    if (match[2].length > MAX_ENV_VALUE_CHARS) {
      throw new Error(`Env map values cannot contain more than ${MAX_ENV_VALUE_CHARS} characters.`);
    }
    map[match[1]] = match[2];
  }
  if (Object.keys(map).length > MAX_ENV_KEYS) {
    throw new Error(`Env map cannot contain more than ${MAX_ENV_KEYS} entries.`);
  }
  return map;
}

function serializeEnvMapText(map) {
  const normalized = normalizeEnvMap(map) || {};
  return Object.keys(normalized).sort().map((key) => `${key}=${normalized[key]}`).join('\n');
}

function parseDotenv(contents) {
  const text = String(contents ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_ENV_FILE_BYTES) {
    throw launchEnvError('INVALID_DOTENV', 'The env file is larger than Runlist allows.');
  }
  const lines = text.split(/\r?\n/);
  const result = {};
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (!line.trim()) {
      continue;
    }
    if (line.trimStart().startsWith('#')) {
      continue;
    }
    if (/^\s*export\s+/.test(line)) {
      line = line.replace(/^\s*export\s+/, '');
    }
    const equals = line.indexOf('=');
    if (equals <= 0) {
      throw launchEnvError(
        'INVALID_DOTENV',
        `The env file has an invalid line ${index + 1}. Use KEY=value format.`
      );
    }
    const key = line.slice(0, equals).trim();
    if (!ENV_NAME_PATTERN.test(key)) {
      throw launchEnvError(
        'INVALID_DOTENV',
        `The env file has an invalid variable name on line ${index + 1}.`
      );
    }
    let value = line.slice(equals + 1);
    if (value.startsWith('"')) {
      const closed = value.match(/^"((?:\\.|[^"\\])*)"/);
      if (!closed || closed[0].length !== value.trimEnd().length) {
        throw launchEnvError(
          'INVALID_DOTENV',
          `The env file has an invalid quoted value on line ${index + 1}.`
        );
      }
      value = closed[1].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'")) {
      const closed = value.match(/^'([^']*)'/);
      if (!closed || closed[0].length !== value.trimEnd().length) {
        throw launchEnvError(
          'INVALID_DOTENV',
          `The env file has an invalid quoted value on line ${index + 1}.`
        );
      }
      value = closed[1];
    } else {
      const comment = value.search(/\s+#/);
      if (comment >= 0) {
        value = value.slice(0, comment);
      }
      value = value.trimEnd();
    }
    if (value.length > MAX_ENV_VALUE_CHARS) {
      throw launchEnvError(
        'INVALID_DOTENV',
        `The env file value on line ${index + 1} is too long.`
      );
    }
    result[key] = value;
  }
  if (Object.keys(result).length > MAX_ENV_KEYS) {
    throw launchEnvError('INVALID_DOTENV', `The env file cannot contain more than ${MAX_ENV_KEYS} entries.`);
  }
  return result;
}

function resolveEnvFilePath(projectFolder, envFile) {
  const relative = normalizeEnvFile(envFile);
  if (!relative) {
    throw launchEnvError('INVALID_ENV_FILE', 'Env file path is required.');
  }
  if (typeof projectFolder !== 'string' || !projectFolder.trim() || !path.isAbsolute(projectFolder)) {
    throw launchEnvError('INVALID_ENV_FILE', 'Project folder is required to load an env file.');
  }
  const root = path.resolve(projectFolder);
  const resolved = path.resolve(root, ...relative.split('/'));
  if (!isPathInside(resolved, root)) {
    throw launchEnvError('PATH_ESCAPE', 'Env file path must stay inside the project folder.');
  }
  return resolved;
}

function readProjectEnvFile(projectFolder, envFile) {
  const target = resolveEnvFilePath(projectFolder, envFile);
  let contents;
  try {
    contents = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw launchEnvError(
        'ENV_FILE_MISSING',
        `Could not find env file “${normalizeEnvFile(envFile)}” in the project folder.`,
        { cause: error }
      );
    }
    throw launchEnvError(
      'ENV_FILE_UNREADABLE',
      `Could not read env file “${normalizeEnvFile(envFile)}”.`,
      { cause: error }
    );
  }
  return parseDotenv(contents);
}

function mergeLaunchEnvironment({
  baseEnvironment,
  fileEnvironment,
  explicitEnvironment,
  portOverrides
} = {}) {
  const merged = {
    ...(baseEnvironment || {}),
    ...(fileEnvironment || {}),
    ...(explicitEnvironment || {})
  };
  return projectLaunchEnvironment(merged, portOverrides || []);
}

function resolveProjectLaunchEnvironment(project = {}, baseEnvironment, portOverrides = []) {
  const fileEnvironment = project.envFile
    ? readProjectEnvFile(project.folder, project.envFile)
    : undefined;
  const explicitEnvironment = normalizeEnvMap(project.env);
  return mergeLaunchEnvironment({
    baseEnvironment,
    fileEnvironment,
    explicitEnvironment,
    portOverrides
  });
}

function collectLaunchEnvSecretValues(project = {}) {
  const values = new Set();
  const addMap = (map) => {
    for (const value of Object.values(map || {})) {
      if (typeof value === 'string' && value.length >= 4) {
        values.add(value);
      }
    }
  };
  addMap(normalizeEnvMap(project.env));
  if (project.envFile && project.folder) {
    try {
      addMap(readProjectEnvFile(project.folder, project.envFile));
    } catch {
      // Missing or invalid files are handled at Start; redaction stays best-effort.
    }
  }
  return [...values];
}

function redactKnownEnvValues(text, secretValues = []) {
  let result = String(text || '');
  const values = [...new Set((secretValues || [])
    .filter((value) => typeof value === 'string' && value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    result = result.split(value).join('[redacted]');
  }
  return result;
}

function isPathInside(candidate, root) {
  const normalizedRoot = normalizePathKey(root);
  const normalizedCandidate = normalizePathKey(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function normalizePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function launchEnvError(code, message, options) {
  return new LaunchEnvError(code, message, options);
}

module.exports = {
  LaunchEnvError,
  collectLaunchEnvSecretValues,
  envFileValidationMessage,
  envMapTextValidationMessage,
  mergeLaunchEnvironment,
  normalizeEnvFile,
  normalizeEnvMap,
  parseDotenv,
  parseEnvMapText,
  readProjectEnvFile,
  redactKnownEnvValues,
  resolveEnvFilePath,
  resolveProjectLaunchEnvironment,
  serializeEnvMapText
};
