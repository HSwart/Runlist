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

function isEnvValueEmpty(value) {
  return typeof value === 'string' && value.trim().length === 0;
}

function isEnvValuePresent(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missingRequiredEnvKeys(requiredKeys, environment = {}) {
  const present = new Set(
    Object.entries(environment || {})
      .filter(([, value]) => isEnvValuePresent(value))
      .map(([key]) => key)
  );
  return (requiredKeys || []).filter((key) => !present.has(key));
}

function emptyEnvKeysFromDotenv(map) {
  return Object.entries(map || {})
    .filter(([, value]) => isEnvValueEmpty(value))
    .map(([key]) => key)
    .sort();
}

function emptyEnvKeysFromLocalSettings(json) {
  const values = json?.Values ?? json?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return [];
  }
  return Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && isEnvValueEmpty(value))
    .map(([key]) => key)
    .sort();
}

function classifyRequiredEnvPresence(requiredKeys, mergedEnv = {}, sources = []) {
  const missing = [];
  const emptyBySource = [];
  const emptySourceIndex = new Map();

  for (const key of requiredKeys || []) {
    if (!Object.hasOwn(mergedEnv, key)) {
      missing.push(key);
      continue;
    }
    if (!isEnvValueEmpty(mergedEnv[key])) {
      continue;
    }
    let attributed = false;
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const source = sources[index];
      const env = source?.env;
      if (!env || !Object.hasOwn(env, key) || !isEnvValueEmpty(env[key])) {
        continue;
      }
      const label = String(source.label || 'environment');
      if (!emptySourceIndex.has(label)) {
        emptySourceIndex.set(label, emptyBySource.length);
        emptyBySource.push({ source: label, keys: [] });
      }
      emptyBySource[emptySourceIndex.get(label)].keys.push(key);
      attributed = true;
      break;
    }
    if (!attributed) {
      const label = 'environment';
      if (!emptySourceIndex.has(label)) {
        emptySourceIndex.set(label, emptyBySource.length);
        emptyBySource.push({ source: label, keys: [] });
      }
      emptyBySource[emptySourceIndex.get(label)].keys.push(key);
    }
  }

  for (const entry of emptyBySource) {
    entry.keys.sort();
  }
  missing.sort();
  return { missing, emptyBySource };
}

function collectAdvisoryEmptyKeysBySource(entries = []) {
  const result = [];
  for (const entry of entries) {
    const keys = entry.map
      ? emptyEnvKeysFromDotenv(entry.map)
      : emptyEnvKeysFromLocalSettings(entry.settings);
    if (keys.length) {
      result.push({ source: entry.label, keys });
    }
  }
  return result;
}

function formatRequiredEnvFailureDetail({ missing = [], emptyBySource = [] } = {}) {
  const parts = [];
  if (missing.length) {
    parts.push(`Missing: ${missing.join(', ')}`);
  }
  for (const { source, keys } of emptyBySource) {
    if (keys.length) {
      parts.push(`Empty in ${source}: ${keys.join(', ')}`);
    }
  }
  if (!parts.length) {
    return 'Required environment variables are not set for this launch profile.';
  }
  return `Required environment variables are not set for this launch profile. ${parts.join('; ')}.`;
}

function hasRequiredEnvPresenceIssues({ missing = [], emptyBySource = [] } = {}) {
  if (missing.length) {
    return true;
  }
  return emptyBySource.some((entry) => entry.keys?.length);
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
      .filter(([, value]) => isEnvValuePresent(value))
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
  advisoryMissing = [],
  advisoryEmptyBySource = [],
  envLocalHint
} = {}) {
  const warnings = [];
  if (requiredMissing.length) {
    warnings.push(
      `Missing required environment variables for this launch profile: ${requiredMissing.join(', ')}.`
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
  for (const { source, keys } of advisoryEmptyBySource) {
    if (keys.length) {
      warnings.push(
        `Empty environment variables in ${source} (Start continues): ${keys.join(', ')}.`
      );
    }
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
  classifyRequiredEnvPresence,
  collectAdvisoryEmptyKeysBySource,
  emptyEnvKeysFromDotenv,
  emptyEnvKeysFromLocalSettings,
  envLocalAttachHint,
  exampleEnvAdvisoryMissing,
  exampleEnvKeys,
  formatEnvPresenceWarnings,
  formatRequiredEnvFailureDetail,
  hasRequiredEnvPresenceIssues,
  isEnvValueEmpty,
  isEnvValuePresent,
  isMissingRequiredEnvFailure,
  isTestOnlyEnvKey,
  missingRequiredEnvKeys,
  normalizeRequiredEnvKeys,
  resolveExplicitRequiredEnvKeys
};
