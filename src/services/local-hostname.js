const { safeServiceUrl } = require('./external-url');

const MAX_LOCAL_HOSTNAME_LENGTH = 63;
const LOCAL_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function slugifyLocalHostname(value) {
  const slug = String(value || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LOCAL_HOSTNAME_LENGTH)
    .replace(/-+$/g, '');
  if (!slug || localHostnameValidationMessage(slug)) {
    return undefined;
  }
  return slug;
}

function localHostnameValidationMessage(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return 'Local hostname must be text.';
  }
  const trimmed = value.trim().toLocaleLowerCase('en-US');
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_LOCAL_HOSTNAME_LENGTH) {
    return `Local hostname must be at most ${MAX_LOCAL_HOSTNAME_LENGTH} characters.`;
  }
  if (!LOCAL_HOSTNAME_PATTERN.test(trimmed)) {
    return 'Local hostname must use lowercase letters, digits, and hyphens, and cannot start or end with a hyphen.';
  }
  return undefined;
}

function normalizeLocalHostname(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const message = localHostnameValidationMessage(value);
  if (message) {
    throw new Error(message);
  }
  return String(value).trim().toLocaleLowerCase('en-US');
}

function defaultLocalHostname(project = {}) {
  if (project.localHostname) {
    return normalizeLocalHostname(project.localHostname);
  }
  return slugifyLocalHostname(project.name);
}

function buildNamedLocalUrl({ hostname, port, pathname = '/' } = {}) {
  const label = normalizeLocalHostname(hostname) || slugifyLocalHostname(hostname);
  if (!label || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  const path = pathname && pathname !== '/' ? pathname : '/';
  return safeServiceUrl(`http://${label}.localhost:${port}${path === '/' ? '/' : path}`);
}

function preferredServiceOpenUrl({ project, service, port } = {}) {
  const override = typeof service?.url === 'string' ? service.url.trim() : '';
  if (override) {
    return safeServiceUrl(override);
  }
  const effectivePort = Number.isInteger(port) ? port : service?.port;
  const hostname = defaultLocalHostname(project);
  if (hostname) {
    const named = buildNamedLocalUrl({ hostname, port: effectivePort });
    if (named) {
      return named;
    }
  }
  if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) {
    return undefined;
  }
  return safeServiceUrl(`http://localhost:${effectivePort}/`);
}

function findLocalHostnameCollisions(projects, hostname, excludeProjectId) {
  const label = normalizeLocalHostname(hostname) || slugifyLocalHostname(hostname);
  if (!label) {
    return [];
  }
  return (Array.isArray(projects) ? projects : []).filter((project) => {
    if (excludeProjectId && project.id === excludeProjectId) {
      return false;
    }
    return defaultLocalHostname(project) === label;
  });
}

module.exports = {
  buildNamedLocalUrl,
  defaultLocalHostname,
  findLocalHostnameCollisions,
  localHostnameValidationMessage,
  normalizeLocalHostname,
  preferredServiceOpenUrl,
  slugifyLocalHostname
};
