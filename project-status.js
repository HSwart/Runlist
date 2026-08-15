const net = require('net');

function isPortOpen(port, options = {}) {
  const host = options.host || '127.0.0.1';
  const timeout = options.timeout || 300;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function areServicesRunning(services) {
  if (!Array.isArray(services) || services.length === 0) {
    return false;
  }
  const results = await Promise.all(services.map((service) => isPortOpen(service.port)));
  return results.every(Boolean);
}

function primaryServiceUrl(services) {
  const port = services?.[0]?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return `http://127.0.0.1:${port}`;
}

module.exports = { areServicesRunning, isPortOpen, primaryServiceUrl };
