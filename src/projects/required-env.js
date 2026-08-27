const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_REQUIRED_ENV_KEYS = 64;
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

function missingRequiredEnvKeys(requiredKeys, environment = {}) {
  const present = new Set(
    Object.entries(environment || {})
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([key]) => key)
  );
  return (requiredKeys || []).filter((key) => !present.has(key));
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
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
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
  envLocalAttachHint,
  exampleEnvAdvisoryMissing,
  exampleEnvKeys,
  formatEnvPresenceWarnings,
  isTestOnlyEnvKey,
  missingRequiredEnvKeys,
  normalizeRequiredEnvKeys,
  resolveExplicitRequiredEnvKeys
};
