const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { areServicesRunning, isPortOpen, primaryServiceUrl } = require('../project-status');

test('detects whether configured local service ports are accepting connections', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  assert.equal(await isPortOpen(port), true);
  assert.equal(await areServicesRunning([{ name: 'web', port }]), true);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(await isPortOpen(port), false);
});

test('builds the primary local service URL from the first configured port', () => {
  assert.equal(primaryServiceUrl([{ name: 'web', port: 8787 }]), 'http://127.0.0.1:8787');
  assert.equal(primaryServiceUrl([]), undefined);
});
