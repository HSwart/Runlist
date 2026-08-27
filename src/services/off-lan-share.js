const { safeHttpUrl } = require('./external-url');

/**
 * Off-LAN share via VS Code's own tunnel / port-forward surface.
 * Never invents a URL. Tear down on off / Stop / Restart.
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

  let external;
  try {
    const uri = vscode.Uri.parse(source);
    const resolved = await vscode.env.asExternalUri(uri);
    external = safeHttpUrl(resolved?.toString?.() || String(resolved || ''));
  } catch (error) {
    return {
      ok: false,
      message: plainShareError(error, 'VS Code could not create an off-LAN URL for this port.')
    };
  }

  if (!external) {
    return {
      ok: false,
      message: 'VS Code did not return a shareable URL for this port.'
    };
  }

  if (!isOffLanShareUrl(external)) {
    if (typeof options.tryForwardPort === 'function') {
      try {
        await options.tryForwardPort(source);
        const retry = await vscode.env.asExternalUri(vscode.Uri.parse(source));
        external = safeHttpUrl(retry?.toString?.() || String(retry || ''));
      } catch (error) {
        return {
          ok: false,
          message: plainShareError(
            error,
            'VS Code could not forward this port off your LAN. Sign in to VS Code tunnels if prompted, then try again.'
          )
        };
      }
    }
  }

  if (!external || !isOffLanShareUrl(external)) {
    return {
      ok: false,
      message: 'VS Code could not create an off-LAN URL for this port. Sign in to VS Code tunnels if prompted, then try again.'
    };
  }

  return { ok: true, url: external };
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
  isOffLanShareUrl
};
