const http = require('http');
const net = require('net');
const { URL } = require('url');

const MAX_ENTRIES = 50;
const MAX_BODY_BYTES = 8 * 1024;
const REDACT_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

/**
 * Inbound HTTP inspector for one Runlist-started web port.
 * Observes by proxying configuredPort → upstreamPort without changing the
 * user-facing port. Hide the UI when observation is unavailable.
 */

function createHttpInspectorStore() {
  const byProject = new Map();

  function list(projectId) {
    return [...(byProject.get(projectId)?.entries || [])];
  }

  function clear(projectId) {
    const session = byProject.get(projectId);
    if (session?.proxy) {
      try {
        session.proxy.close();
      } catch {
        // Ignore close races.
      }
    }
    byProject.delete(projectId);
  }

  function clearAll() {
    for (const id of [...byProject.keys()]) {
      clear(id);
    }
  }

  function record(projectId, entry) {
    const session = byProject.get(projectId);
    if (!session) {
      return;
    }
    session.entries.unshift(entry);
    if (session.entries.length > MAX_ENTRIES) {
      session.entries.length = MAX_ENTRIES;
    }
  }

  function isObserving(projectId) {
    return byProject.get(projectId)?.observing === true;
  }

  async function startProxy(projectId, { configuredPort, upstreamPort, onChange } = {}) {
    clear(projectId);
    if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
      return { ok: false, reason: 'hidden' };
    }
    if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
      return { ok: false, reason: 'hidden' };
    }
    if (configuredPort === upstreamPort) {
      return { ok: false, reason: 'hidden' };
    }

    const session = {
      entries: [],
      observing: false,
      configuredPort,
      upstreamPort,
      proxy: null
    };
    byProject.set(projectId, session);

    try {
      const proxy = await listenHttpProxy({
        listenPort: configuredPort,
        upstreamPort,
        onRequest: (entry) => {
          record(projectId, entry);
          onChange?.(projectId);
        }
      });
      session.proxy = proxy;
      session.observing = true;
      return { ok: true, configuredPort, upstreamPort };
    } catch {
      byProject.delete(projectId);
      return { ok: false, reason: 'hidden' };
    }
  }

  return {
    clear,
    clearAll,
    isObserving,
    list,
    startProxy
  };
}

function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key);
    if (REDACT_HEADERS.has(name.toLowerCase())) {
      out[name] = '[redacted]';
      continue;
    }
    out[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

function truncateBody(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const truncated = buf.length > MAX_BODY_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_BODY_BYTES) : buf;
  let text;
  try {
    text = slice.toString('utf8');
  } catch {
    text = slice.toString('latin1');
  }
  return { text, truncated, bytes: buf.length };
}

function listenHttpProxy({ listenPort, upstreamPort, onRequest }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const started = Date.now();
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        const requestBody = Buffer.concat(chunks);
        const headers = { ...req.headers };
        delete headers['proxy-connection'];
        const upstreamReq = http.request({
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: req.url,
          method: req.method,
          headers
        }, (upstreamRes) => {
          const responseChunks = [];
          upstreamRes.on('data', (chunk) => responseChunks.push(chunk));
          upstreamRes.on('end', () => {
            const responseBody = Buffer.concat(responseChunks);
            const durationMs = Date.now() - started;
            let pathname = req.url || '/';
            try {
              pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname || '/';
            } catch {
              // Keep raw path.
            }
            onRequest?.({
              id: `${started}-${Math.random().toString(36).slice(2, 8)}`,
              at: started,
              method: String(req.method || 'GET').toUpperCase(),
              path: pathname,
              status: upstreamRes.statusCode || 0,
              durationMs,
              requestHeaders: redactHeaders(req.headers),
              responseHeaders: redactHeaders(upstreamRes.headers),
              requestBody: truncateBody(requestBody),
              responseBody: truncateBody(responseBody)
            });
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            res.end(responseBody);
          });
        });
        upstreamReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' });
          }
          res.end('Bad gateway');
        });
        if (requestBody.length) {
          upstreamReq.write(requestBody);
        }
        upstreamReq.end();
      });
    });

    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        close() {
          return new Promise((closeResolve) => {
            server.close(() => closeResolve());
          });
        }
      });
    });
  });
}

function pickInspectorUpstreamPort(configuredPort, usedPorts = []) {
  const used = new Set(usedPorts);
  used.add(configuredPort);
  for (let offset = 1; offset < 2000; offset += 1) {
    const candidate = 41000 + ((configuredPort + offset) % 20000);
    if (!used.has(candidate) && candidate !== configuredPort) {
      return candidate;
    }
  }
  return undefined;
}

function canObserveHttp(project = {}, options = {}) {
  if (options.managed !== true) {
    return false;
  }
  if (!['running', 'starting', 'not-ready', 'not-responding'].includes(String(options.status || ''))) {
    return false;
  }
  const webPorts = Array.isArray(options.webPorts) ? options.webPorts : [];
  if (webPorts.length !== 1) {
    return false;
  }
  if (options.observing !== true) {
    return false;
  }
  return true;
}

async function waitForLocalPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (open) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

module.exports = {
  MAX_BODY_BYTES,
  MAX_ENTRIES,
  canObserveHttp,
  createHttpInspectorStore,
  pickInspectorUpstreamPort,
  redactHeaders,
  truncateBody,
  waitForLocalPort
};
