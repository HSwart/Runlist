const fs = require('fs');
const path = require('path');
const {
  normalizeEnvFile,
  normalizeEnvMap,
  parseDotenv,
  readProjectEnvFile
} = require('./launch-env');

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_REQUIRED_ENV_KEYS = 64;
const MISSING_REQUIRED_ENV_FAILURE_KIND = 'missing-required-env';
const TEST_ONLY_ENV_PREFIXES = [
  'PLAYWRIGHT_',
  'CYPRESS_',
  'TEST_',
  'VITEST_',
  'JEST_',
  'MOCHA_',
  'PYTEST_',
  'WEBDRIVER_'
];

function normalizeRequiredEnvKeys(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Required env keys must be a list of environment variable names.');
  }
  if (value.length > MAX_REQUIRED_ENV_KEYS) {
    throw new Error(`Required env keys cannot contain more than ${MAX_REQUIRED_ENV_KEYS} names.`);
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('Required env keys must be text environment variable names.');
    }
    const key = entry.trim();
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error('Required env keys must be valid environment variable names.');
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }
  return normalized.length ? normalized : undefined;
}

function resolveExplicitRequiredEnvKeys(project = {}) {
  return normalizeRequiredEnvKeys(project.requiredEnvKeys) || [];
}

function classifyRequiredEnvPresence(requiredKeys, environment = {}) {
  const missing = [];
  const empty = [];
  for (const key of requiredKeys || []) {
    if (!Object.prototype.hasOwnProperty.call(environment || {}, key)) {
      missing.push(key);
      continue;
    }
    const value = environment[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      empty.push(key);
    }
  }
  return { missing, empty };
}

function missingRequiredEnvKeys(requiredKeys, environment = {}) {
  const { missing, empty } = classifyRequiredEnvPresence(requiredKeys, environment);
  return [...missing, ...empty];
}

function emptyEnvKeysFromDotenv(map = {}) {
  return Object.entries(map || {})
    .filter(([, value]) => typeof value === 'string' && value.trim().length === 0)
    .map(([key]) => key)
    .sort();
}

function emptyEnvKeysFromLocalSettings(json) {
  const values = json && typeof json === 'object' && !Array.isArray(json)
    ? json.Values
    : undefined;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return [];
  }
  return Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && value.trim().length === 0)
    .map(([key]) => key)
    .sort();
}

function attributeRequiredEmptySources(project = {}, emptyKeys = []) {
  const emptyBySource = {};
  const explicitMap = normalizeEnvMap(project.env) || {};
  const configuredEnvFile = normalizeEnvFile(project.envFile);
  let fileMap = {};
  if (configuredEnvFile && project.folder) {
    try {
      fileMap = readProjectEnvFile(project.folder, configuredEnvFile);
    } catch {
      // Unreadable env files must not crash Start.
    }
  }

  const addToSource = (sourceLabel, key) => {
    if (!emptyBySource[sourceLabel]) {
      emptyBySource[sourceLabel] = [];
    }
    if (!emptyBySource[sourceLabel].includes(key)) {
      emptyBySource[sourceLabel].push(key);
    }
  };

  for (const key of emptyKeys) {
    if (Object.prototype.hasOwnProperty.call(explicitMap, key)
      && typeof explicitMap[key] === 'string'
      && explicitMap[key].trim().length === 0) {
      addToSource('launch profile env map', key);
      continue;
    }
    if (configuredEnvFile
      && Object.prototype.hasOwnProperty.call(fileMap, key)
      && typeof fileMap[key] === 'string'
      && fileMap[key].trim().length === 0) {
      addToSource(configuredEnvFile, key);
      continue;
    }
    addToSource('environment', key);
  }

  for (const source of Object.keys(emptyBySource)) {
    emptyBySource[source].sort();
  }
  return emptyBySource;
}

function readDotenvFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    return parseDotenv(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function collectAdvisoryEmptyEnvBySource(projectFolder, project = {}) {
  const emptyBySource = {};
  const addKeys = (source, keys) => {
    if (!keys.length) {
      return;
    }
    emptyBySource[source] = [...new Set([...(emptyBySource[source] || []), ...keys])].sort();
  };

  const configuredEnvFile = normalizeEnvFile(project.envFile);
  if (configuredEnvFile) {
    const map = readDotenvFileSafe(path.join(projectFolder, ...configuredEnvFile.split('/')));
    if (map) {
      addKeys(configuredEnvFile, emptyEnvKeysFromDotenv(map));
    }
  }

  const rootLocalPath = path.join(projectFolder, '.env.local');
  if (!configuredEnvFile || configuredEnvFile !== '.env.local') {
    const map = readDotenvFileSafe(rootLocalPath);
    if (map) {
      addKeys('.env.local', emptyEnvKeysFromDotenv(map));
    }
  }

  const hostJsonPath = path.join(projectFolder, 'host.json');
  const localSettingsPath = path.join(projectFolder, 'local.settings.json');
  if (fs.existsSync(hostJsonPath) && fs.existsSync(localSettingsPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
      addKeys('local.settings.json', emptyEnvKeysFromLocalSettings(json));
    } catch {
      // Invalid JSON must not crash Start.
    }
  }

  const profileEmpty = emptyEnvKeysFromDotenv(normalizeEnvMap(project.env) || {});
  if (profileEmpty.length) {
    addKeys('launch profile env map', profileEmpty);
  }

  return emptyBySource;
}

function formatRequiredEnvFailureDetail({ missing = [], emptyBySource = {} } = {}) {
  const lines = [];
  if (missing.length) {
    lines.push(`Missing: ${[...missing].sort().join(', ')}`);
  }
  for (const source of Object.keys(emptyBySource).sort()) {
    const keys = emptyBySource[source];
    if (!keys.length) {
      continue;
    }
    lines.push(`Empty in ${source}: ${keys.join(', ')}`);
  }
  if (!lines.length) {
    return 'Required environment variables are not ready for this launch profile.';
  }
  return `Required environment variables are not ready for this launch profile.\n${lines.join('\n')}`;
}

function isMissingRequiredEnvFailure(failure = {}) {
  if (!failure || typeof failure !== 'object') {
    return false;
  }
  return failure.kind === MISSING_REQUIRED_ENV_FAILURE_KIND
    || failure.failureKind === MISSING_REQUIRED_ENV_FAILURE_KIND;
}

function isTestOnlyEnvKey(key) {
  const name = String(key || '');
  return TEST_ONLY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function exampleEnvKeys(text) {
  const keys = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !ENV_NAME_PATTERN.test(match[1]) || seen.has(match[1])) {
      continue;
    }
    const exampleValue = match[2].trim().replace(/^["']|["']$/g, '');
    // Empty placeholders stay optional / documentation-only.
    if (!exampleValue) {
      continue;
    }
    seen.add(match[1]);
    keys.push(match[1]);
  }
  return keys;
}

function exampleEnvAdvisoryMissing(exampleText, environment = {}) {
  const present = new Set(
    Object.entries(environment || {})
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key]) => key)
  );
  const advisoryMissing = exampleEnvKeys(exampleText).filter((key) => !present.has(key));
  return {
    // .env.example never hard-blocks Start by itself.
    requiredMissing: [],
    advisoryMissing
  };
}

function formatEnvPresenceWarnings({
  requiredMissing = [],
  requiredEmptyBySource = {},
  advisoryMissing = [],
  advisoryEmptyBySource = {},
  envLocalHint
} = {}) {
  const warnings = [];
  if (requiredMissing.length) {
    warnings.push(
      `Required variables are missing (Start continues): ${[...requiredMissing].sort().join(', ')}.`
    );
  }
  for (const source of Object.keys(requiredEmptyBySource).sort()) {
    const keys = requiredEmptyBySource[source];
    if (!keys.length) {
      continue;
    }
    warnings.push(
      `Required variables are empty in ${source} (Start continues): ${keys.join(', ')}.`
    );
  }
  const testOnly = advisoryMissing.filter((key) => isTestOnlyEnvKey(key));
  const other = advisoryMissing.filter((key) => !isTestOnlyEnvKey(key));
  if (other.length) {
    warnings.push(
      `Optional .env.example keys are unset (Start continues): ${other.join(', ')}.`
    );
  }
  if (testOnly.length) {
    warnings.push(
      `Test-only .env.example keys are unset (Start continues): ${testOnly.join(', ')}.`
    );
  }
  for (const source of Object.keys(advisoryEmptyBySource).sort()) {
    const keys = advisoryEmptyBySource[source];
    if (!keys.length) {
      continue;
    }
    warnings.push(`Empty variables in ${source} (Start continues): ${keys.join(', ')}.`);
  }
  if (envLocalHint) {
    warnings.push(envLocalHint);
  }
  return warnings;
}

function envLocalAttachHint(envFile, localExists) {
  if (!localExists) {
    return undefined;
  }
  const configured = typeof envFile === 'string' ? envFile.trim().replace(/\\/g, '/') : '';
  if (configured === '.env.local') {
    return undefined;
  }
  return 'Found .env.local. Attach it as this launch profile’s reviewed env file if those values should load at Start.';
}

module.exports = {
  MAX_REQUIRED_ENV_KEYS,
  MISSING_REQUIRED_ENV_FAILURE_KIND,
  attributeRequiredEmptySources,
  classifyRequiredEnvPresence,
  collectAdvisoryEmptyEnvBySource,
  emptyEnvKeysFromDotenv,
  emptyEnvKeysFromLocalSettings,
  envLocalAttachHint,
  exampleEnvAdvisoryMissing,
  exampleEnvKeys,
  formatEnvPresenceWarnings,
  formatRequiredEnvFailureDetail,
  isMissingRequiredEnvFailure,
  isTestOnlyEnvKey,
  missingRequiredEnvKeys,
  normalizeRequiredEnvKeys,
  resolveExplicitRequiredEnvKeys
};
