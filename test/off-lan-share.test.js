const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const {
  createOffLanShareUrl,
  isOffLanShareUrl,
  startShareProxy
} = require('../src/services/off-lan-share');

test('accepts only non-loopback non-LAN share URLs', () => {
  assert.equal(isOffLanShareUrl('https://abc.tunnel.dev/'), true);
  assert.equal(isOffLanShareUrl('http://localhost:3000/'), false);
  assert.equal(isOffLanShareUrl('http://192.168.1.20:3000/'), false);
  assert.equal(isOffLanShareUrl('http://app.localhost:3000/'), false);
});

test('share proxy stops serving after dispose', async () => {
  const upstream = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const proxy = await startShareProxy({
    targetHost: '127.0.0.1',
    targetPort: upstream.port
  });

  assert.equal(await canConnect(proxy.port), true);
  await proxy.dispose();
  assert.equal(await canConnect(proxy.port), false);
  await upstream.close();
});

test('fails closed when asExternalUri stays on localhost and disposes proxy', async () => {
  const upstream = await listenHttp((req, res) => res.end('ok'));
  const result = await createOffLanShareUrl({
    Uri: { parse: (value) => ({ toString: () => value }) },
    env: {
      asExternalUri: async () => ({ toString: () => 'http://127.0.0.1:3000/' })
    }
  }, `http://127.0.0.1:${upstream.port}/`);
  assert.equal(result.ok, false);
  assert.match(result.message, /off-LAN|tunnel/i);
  await upstream.close();
});

test('returns the external URL and a disposable proxy when VS Code provides one', async () => {
  const upstream = await listenHttp((req, res) => res.end('ok'));
  const result = await createOffLanShareUrl({
    Uri: { parse: (value) => ({ toString: () => value }) },
    env: {
      asExternalUri: async () => ({ toString: () => 'https://share.example.dev/' })
    }
  }, `http://127.0.0.1:${upstream.port}/`);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://share.example.dev/');
  assert.equal(typeof result.dispose, 'function');
  await result.dispose();
  assert.equal(await canConnect(result.proxyPort), false);
  await upstream.close();
});

function listenHttp(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
