const net = require('net');
const { safeHttpUrl } = require('./external-url');

/**
 * Off-LAN share via VS Code's own tunnel / port-forward surface.
 * Runlist owns a local proxy in front of the app so Off/Stop can stop serving
 * even when VS Code keeps the tunnel socket open.
 */

function isLoopbackOrLanUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
      return true;
    }
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isOffLanShareUrl(url) {
  const safe = safeHttpUrl(url);
  if (!safe) {
    return false;
  }
  return !isLoopbackOrLanUrl(safe);
}

async function createOffLanShareUrl(vscode, localUrl, options = {}) {
  const source = safeHttpUrl(localUrl);
  if (!source) {
    return { ok: false, message: 'No web URL is available to share.' };
  }

  let target;
  try {
    target = new URL(source);
  } catch {
    return { ok: false, message: 'No web URL is available to share.' };
  }
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return { ok: false, message: 'No web URL is available to share.' };
  }

  let proxy;
  try {
    proxy = await startShareProxy({
      targetHost: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
      targetPort,
      pathname: target.pathname || '/'
    });
  } catch (error) {
    return {
      ok: false,
      message: plainShareError(error, 'Runlist could not prepare a shareable local proxy for this port.')
    };
  }

  const proxyUrl = safeHttpUrl(`http://127.0.0.1:${proxy.port}/`);
  let external;
  try {
    const uri = vscode.Uri.parse(proxyUrl);
    const resolved = await vscode.env.asExternalUri(uri);
    external = safeHttpUrl(resolved?.toString?.() || String(resolved || ''));
  } catch (error) {
    await proxy.dispose();
    return {
      ok: false,
      message: plainShareError(error, 'VS Code could not create an off-LAN URL for this port.')
    };
  }

  if (!external) {
    await proxy.dispose();
    return {
      ok: false,
      message: 'VS Code did not return a shareable URL for this port.'
    };
  }

  if (!isOffLanShareUrl(external) && typeof options.tryForwardPort === 'function') {
    try {
      await options.tryForwardPort(proxyUrl);
      const retry = await vscode.env.asExternalUri(vscode.Uri.parse(proxyUrl));
      external = safeHttpUrl(retry?.toString?.() || String(retry || ''));
    } catch (error) {
      await proxy.dispose();
      return {
        ok: false,
        message: plainShareError(
          error,
          'VS Code could not forward this port off your LAN. Sign in to VS Code tunnels if prompted, then try again.'
        )
      };
    }
  }

  if (!external || !isOffLanShareUrl(external)) {
    await proxy.dispose();
    return {
      ok: false,
      message: 'VS Code could not create an off-LAN URL for this port. Sign in to VS Code tunnels if prompted, then try again.'
    };
  }

  return {
    ok: true,
    url: external,
    localProxyUrl: proxyUrl,
    proxyPort: proxy.port,
    dispose: () => proxy.dispose()
  };
}

function startShareProxy({ targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((client) => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => {
        client.destroy();
      });
      client.on('error', () => {
        upstream.destroy();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : undefined;
      if (!Number.isInteger(port)) {
        server.close();
        reject(new Error('Could not bind a local share proxy.'));
        return;
      }
      resolve({
        port,
        dispose() {
          for (const socket of sockets) {
            try {
              socket.destroy();
            } catch {
              // Ignore.
            }
          }
          sockets.clear();
          return new Promise((closeResolve) => {
            server.close(() => closeResolve());
            setTimeout(closeResolve, 100);
          });
        }
      });
    });
  });
}

function plainShareError(error, fallback) {
  const detail = String(error?.message || '').trim();
  if (/login|auth|sign in|tunnel/i.test(detail)) {
    return 'VS Code needs its own tunnel sign-in before this port can be shared off your LAN.';
  }
  return detail || fallback;
}

module.exports = {
  createOffLanShareUrl,
  isLoopbackOrLanUrl,
  isOffLanShareUrl,
  startShareProxy
};
