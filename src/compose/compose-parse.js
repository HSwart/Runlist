const path = require('path');
const { ComposeFileError } = require('./compose-file');
const { normalizeEnvFile } = require('../projects/launch-env');

/**
 * Parse a Compose document into reviewable Runlist service proposals.
 * Zero-dependency subset YAML: fails closed on anchors, tags, and unclear structure.
 * Never executes docker compose.
 */
function parseComposeServices(contents, options = {}) {
  const text = String(contents ?? '');
  if (!text.trim()) {
    throw composeError('COMPOSE_EMPTY', 'This Compose file is empty.');
  }
  assertSafeComposeYaml(text);
  let document;
  try {
    document = parseIndentationYaml(text);
  } catch (error) {
    if (error instanceof ComposeFileError) {
      throw error;
    }
    throw composeError(
      'COMPOSE_INVALID',
      'This Compose file is not valid YAML that Runlist can read.',
      { cause: error }
    );
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw composeError(
      'COMPOSE_INVALID',
      'This Compose file must be a mapping with a services section.'
    );
  }
  const servicesNode = document.services;
  if (servicesNode === undefined) {
    throw composeError(
      'COMPOSE_NO_SERVICES',
      'This Compose file has no services section to import.'
    );
  }
  if (!servicesNode || typeof servicesNode !== 'object' || Array.isArray(servicesNode)) {
    throw composeError(
      'COMPOSE_INVALID_SERVICES',
      'The services section must be a mapping of service names.'
    );
  }

  const serviceNames = Object.keys(servicesNode);
  if (!serviceNames.length) {
    throw composeError(
      'COMPOSE_NO_SERVICES',
      'This Compose file lists no services to import.'
    );
  }

  const services = [];
  for (const name of serviceNames) {
    const definition = servicesNode[name];
    if (definition === null || definition === undefined) {
      services.push({
        name,
        ports: [],
        profiles: [],
        note: 'No published host ports'
      });
      continue;
    }
    if (typeof definition !== 'object' || Array.isArray(definition)) {
      throw composeError(
        'COMPOSE_INVALID_SERVICE',
        `Service ${name} is not a mapping Runlist can import.`
      );
    }
    const ports = publishedHostPorts(definition.ports, name);
    const profiles = serviceProfiles(definition.profiles, name);
    services.push({
      name,
      ports,
      profiles,
      note: ports.length ? undefined : 'No published host ports'
    });
  }

  return {
    composePath: typeof options.composePath === 'string' ? options.composePath : undefined,
    envFile: composeImportEnvFile(document, servicesNode),
    services
  };
}

function buildComposeImportProposal(options = {}) {
  const folder = typeof options.folder === 'string' ? options.folder.trim() : '';
  if (!folder) {
    throw composeError('COMPOSE_FOLDER_REQUIRED', 'Choose a project folder before importing Compose services.');
  }
  const parsed = options.parsed || parseComposeServices(options.contents, {
    composePath: options.composePath
  });
  const composePath = options.composePath || parsed.composePath;
  const projectName = typeof options.projectName === 'string' && options.projectName.trim()
    ? options.projectName.trim()
    : path.basename(folder);
  const runlistServices = [];
  for (const service of parsed.services) {
    for (const port of service.ports) {
      runlistServices.push({
        name: service.ports.length > 1 ? `${service.name}:${port}` : service.name,
        port: coerceComposeImportPort(port),
        url: '',
        composeService: service.name,
        profiles: service.profiles
      });
    }
  }

  const serviceArgs = [...new Set(parsed.services.map((service) => service.name))].join(' ');
  const startCommand = serviceArgs
    ? `docker compose up ${serviceArgs}`
    : 'docker compose up';
  const stopCommand = serviceArgs
    ? `docker compose stop ${serviceArgs}`
    : 'docker compose stop';

  return {
    composePath,
    folder,
    projectName,
    parsedServices: parsed.services,
    proposedProject: {
      name: projectName,
      folder,
      startCommand,
      stopCommand,
      services: composeImportServicesForSave(runlistServices),
      ...(composePath ? { composePath } : {}),
      ...(parsed.envFile ? { envFile: parsed.envFile } : {}),
      reviewRequired: false
    },
    warnings: parsed.services
      .filter((service) => !service.ports.length)
      .map((service) => `${service.name} has no published host port, so it will not become a Runlist service row yet.`)
  };
}

function composeImportEnvFile(document, servicesNode) {
  const candidates = [
    ...composeEnvFileEntries(document?.env_file),
    ...Object.values(servicesNode && typeof servicesNode === 'object' && !Array.isArray(servicesNode)
      ? servicesNode
      : {}).flatMap((definition) => (
      definition && typeof definition === 'object' && !Array.isArray(definition)
        ? composeEnvFileEntries(definition.env_file)
        : []
    ))
  ];
  for (const candidate of candidates) {
    try {
      const normalized = normalizeEnvFile(candidate);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Invalid paths stay out of the existing envFile field.
    }
  }
  return undefined;
}

function composeEnvFileEntries(node) {
  if (node === undefined || node === null) {
    return [];
  }
  const entries = Array.isArray(node) ? node : [node];
  const paths = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim()) {
      paths.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.path === 'string') {
      const value = entry.path.trim();
      if (value) {
        paths.push(value);
      }
    }
  }
  return paths;
}

function assertSafeComposeYaml(text) {
  if (/\t/.test(text)) {
    throw composeError(
      'COMPOSE_TABS',
      'This Compose file uses tab indentation. Runlist only reads space-indented Compose YAML.'
    );
  }
  // Anchors, aliases, and explicit tags are out of the safe subset.
  if (/(?:^|[\s,{[])[&*][A-Za-z0-9_-]+/.test(text) || /(?:^|[\s,{[])![A-Za-z]/.test(text)) {
    throw composeError(
      'COMPOSE_UNSUPPORTED_YAML',
      'This Compose file uses YAML anchors, aliases, or tags that Runlist will not interpret. Simplify the file or import services manually.'
    );
  }
}

function publishedHostPorts(portsNode, serviceName) {
  if (portsNode === undefined || portsNode === null) {
    return [];
  }
  if (!Array.isArray(portsNode)) {
    throw composeError(
      'COMPOSE_INVALID_PORTS',
      `Service ${serviceName} ports must be a list.`
    );
  }
  const ports = [];
  for (const entry of portsNode) {
    const port = publishedHostPort(entry, serviceName);
    if (port !== undefined) {
      ports.push(port);
    }
  }
  return [...new Set(ports)].sort((left, right) => left - right);
}

function publishedHostPort(entry, serviceName) {
  if (typeof entry === 'number') {
    // Bare container port — not published to the host.
    return undefined;
  }
  if (typeof entry === 'string') {
    return parseShortPort(entry, serviceName);
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    if (Object.hasOwn(entry, 'published')) {
      const published = Number(entry.published);
      if (!Number.isInteger(published) || published < 1 || published > 65535) {
        throw composeError(
          'COMPOSE_INVALID_PORT',
          `Service ${serviceName} has an invalid published port.`
        );
      }
      return published;
    }
    // Long syntax without published = container-only.
    return undefined;
  }
  throw composeError(
    'COMPOSE_INVALID_PORT',
    `Service ${serviceName} has a port entry Runlist cannot read.`
  );
}

function parseShortPort(value, serviceName) {
  const text = value.trim();
  if (!text) {
    throw composeError(
      'COMPOSE_INVALID_PORT',
      `Service ${serviceName} has an empty port entry.`
    );
  }
  if (/[-\/]/.test(text.split(':').slice(-2).join(':'))) {
    // Ranges like 3000-3005 are ambiguous for a single Runlist service port.
    throw composeError(
      'COMPOSE_PORT_RANGE',
      `Service ${serviceName} publishes a port range. Runlist imports one host port per service row — edit the Compose ports or add services manually.`
    );
  }
  // Formats: CONTAINER | HOST:CONTAINER | IP:HOST:CONTAINER | HOST:CONTAINER/PROTOCOL
  const withoutProtocol = text.replace(/\/(tcp|udp)$/i, '');
  const parts = withoutProtocol.split(':');
  let hostPort;
  if (parts.length === 1) {
    return undefined;
  }
  if (parts.length === 2) {
    hostPort = Number(parts[0]);
  } else if (parts.length === 3) {
    hostPort = Number(parts[1]);
  } else {
    throw composeError(
      'COMPOSE_INVALID_PORT',
      `Service ${serviceName} has a port entry Runlist cannot read.`
    );
  }
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    throw composeError(
      'COMPOSE_INVALID_PORT',
      `Service ${serviceName} has an invalid published host port.`
    );
  }
  return hostPort;
}

function serviceProfiles(profilesNode, serviceName) {
  if (profilesNode === undefined || profilesNode === null) {
    return [];
  }
  if (!Array.isArray(profilesNode)) {
    throw composeError(
      'COMPOSE_INVALID_PROFILES',
      `Service ${serviceName} profiles must be a list of names.`
    );
  }
  return profilesNode.map((profile) => {
    if (typeof profile !== 'string' || !profile.trim()) {
      throw composeError(
        'COMPOSE_INVALID_PROFILES',
        `Service ${serviceName} has an invalid profile label.`
      );
    }
    return profile.trim();
  });
}

function parseIndentationYaml(text) {
  const lines = tokenizeYamlLines(text);
  const { value, next } = parseBlock(lines, 0, 0);
  if (next < lines.length) {
    throw composeError('COMPOSE_INVALID', 'This Compose file has trailing content Runlist could not parse.');
  }
  return value;
}

function tokenizeYamlLines(text) {
  return text.split(/\r?\n/).map((line, index) => {
    const match = /^( *)(.*)$/.exec(line);
    const indent = match[1].length;
    let content = match[2];
    if (!content || content.startsWith('#')) {
      return null;
    }
    const commentIndex = content.indexOf(' #');
    if (commentIndex >= 0) {
      content = content.slice(0, commentIndex).trimEnd();
    }
    if (!content) {
      return null;
    }
    return { indent, content, line: index + 1 };
  }).filter(Boolean);
}

function parseBlock(lines, index, indent) {
  if (index >= lines.length) {
    return { value: null, next: index };
  }
  const current = lines[index];
  if (current.indent < indent) {
    return { value: null, next: index };
  }
  if (current.indent > indent) {
    throw composeError(
      'COMPOSE_INVALID',
      `Unexpected indentation at line ${current.line}.`
    );
  }
  if (current.content.startsWith('- ')) {
    return parseSequence(lines, index, indent);
  }
  return parseMapping(lines, index, indent);
}

function parseMapping(lines, index, indent) {
  const result = {};
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw composeError('COMPOSE_INVALID', `Unexpected indentation at line ${line.line}.`);
    }
    if (line.content.startsWith('- ')) {
      throw composeError('COMPOSE_INVALID', `Expected a mapping key at line ${line.line}.`);
    }
    const separator = line.content.indexOf(':');
    if (separator < 0) {
      throw composeError('COMPOSE_INVALID', `Expected a key at line ${line.line}.`);
    }
    const key = line.content.slice(0, separator).trim();
    if (!key || /['"{[]/.test(key)) {
      throw composeError(
        'COMPOSE_UNSUPPORTED_YAML',
        `Runlist could not read the key at line ${line.line}.`
      );
    }
    const remainder = line.content.slice(separator + 1).trim();
    cursor += 1;
    if (remainder === '' || remainder === '|' || remainder === '>') {
      if (remainder === '|' || remainder === '>') {
        throw composeError(
          'COMPOSE_UNSUPPORTED_YAML',
          `Runlist does not import multi-line scalars (line ${line.line}).`
        );
      }
      if (cursor < lines.length && lines[cursor].indent > indent) {
        const nested = parseBlock(lines, cursor, lines[cursor].indent);
        result[key] = nested.value;
        cursor = nested.next;
      } else {
        result[key] = null;
      }
      continue;
    }
    if (remainder.startsWith('[') || remainder.startsWith('{')) {
      result[key] = parseFlow(remainder, line.line);
      continue;
    }
    result[key] = parseScalar(remainder, line.line);
  }
  return { value: result, next: cursor };
}

function parseSequence(lines, index, indent) {
  const result = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw composeError('COMPOSE_INVALID', `Unexpected indentation at line ${line.line}.`);
    }
    if (!line.content.startsWith('- ')) {
      break;
    }
    const remainder = line.content.slice(2).trim();
    cursor += 1;
    if (!remainder) {
      if (cursor < lines.length && lines[cursor].indent > indent) {
        const nested = parseBlock(lines, cursor, lines[cursor].indent);
        result.push(nested.value);
        cursor = nested.next;
      } else {
        result.push(null);
      }
      continue;
    }
    if (remainder.includes(':') && !remainder.startsWith('[') && !remainder.startsWith('{')
      && !/^['"]/.test(remainder)
      && !looksLikePortMapping(remainder)) {
      // Inline mapping entry under a sequence item: "- target: 80"
      const item = {};
      const key = remainder.slice(0, remainder.indexOf(':')).trim();
      const after = remainder.slice(remainder.indexOf(':') + 1).trim();
      if (!key) {
        throw composeError('COMPOSE_INVALID', `Expected a key at line ${line.line}.`);
      }
      if (after) {
        item[key] = parseScalar(after, line.line);
      } else if (cursor < lines.length && lines[cursor].indent > indent) {
        const nested = parseBlock(lines, cursor, lines[cursor].indent);
        item[key] = nested.value;
        cursor = nested.next;
      } else {
        item[key] = null;
      }
      while (cursor < lines.length
        && lines[cursor].indent > indent
        && !lines[cursor].content.startsWith('- ')) {
        const nestedIndent = lines[cursor].indent;
        const nested = parseMapping(lines, cursor, nestedIndent);
        Object.assign(item, nested.value);
        cursor = nested.next;
      }
      result.push(item);
      continue;
    }
    if (remainder.startsWith('[') || remainder.startsWith('{')) {
      result.push(parseFlow(remainder, line.line));
      continue;
    }
    if (looksLikePortMapping(remainder)) {
      result.push(remainder);
      continue;
    }
    result.push(parseScalar(remainder, line.line));
  }
  return { value: result, next: cursor };
}

function looksLikePortMapping(text) {
  return /^(?:\d{1,3}(?:\.\d{1,3}){3}:)?\d{1,5}(?:-\d{1,5})?:\d{1,5}(?:-\d{1,5})?(?:\/(?:tcp|udp))?$/i
    .test(text.trim());
}

function parseFlow(text, line) {
  try {
    // Flow collections in Compose are usually JSON-compatible.
    return JSON.parse(text.replace(/'/g, '"'));
  } catch {
    throw composeError(
      'COMPOSE_UNSUPPORTED_YAML',
      `Runlist could not read the inline value at line ${line}.`
    );
  }
}

function parseScalar(text, line) {
  if ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === 'null' || text === '~') {
    return null;
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(text)) {
    return Number(text);
  }
  // Colons are allowed for common Compose values such as image tags (nginx:alpine).
  if (/[{}\[\],&*#]|^\s|\s$/.test(text)) {
    throw composeError(
      'COMPOSE_UNSUPPORTED_YAML',
      `Runlist could not read the value at line ${line}. Quote the value or simplify the file.`
    );
  }
  return text;
}

function composeError(code, message, options) {
  return new ComposeFileError(code, message, options);
}

function coerceComposeImportPort(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      const port = Number(trimmed);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        return port;
      }
    }
  }
  return value;
}

function composeImportServicesForSave(services) {
  return (Array.isArray(services) ? services : []).map((service) => ({
    name: service.name,
    port: coerceComposeImportPort(service.port),
    url: service.url || ''
  }));
}

module.exports = {
  buildComposeImportProposal,
  coerceComposeImportPort,
  composeImportServicesForSave,
  parseComposeServices
};
