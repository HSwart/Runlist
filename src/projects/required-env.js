const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requiredEnvKeysFromExample(text) {
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
    // Empty placeholders in .env.example are treated as optional.
    if (!exampleValue) {
      continue;
    }
    seen.add(match[1]);
    keys.push(match[1]);
  }
  return keys;
}

function missingRequiredEnvKeys(requiredKeys, environment = {}) {
  const present = new Set(
    Object.entries(environment || {})
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([key]) => key)
  );
  return (requiredKeys || []).filter((key) => !present.has(key));
}

module.exports = {
  missingRequiredEnvKeys,
  requiredEnvKeysFromExample
};
