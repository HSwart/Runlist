const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createOffLanShareUrl,
  isOffLanShareUrl
} = require('../src/services/off-lan-share');

test('accepts only non-loopback non-LAN share URLs', () => {
  assert.equal(isOffLanShareUrl('https://abc.tunnel.dev/'), true);
  assert.equal(isOffLanShareUrl('http://localhost:3000/'), false);
  assert.equal(isOffLanShareUrl('http://192.168.1.20:3000/'), false);
  assert.equal(isOffLanShareUrl('http://app.localhost:3000/'), false);
});

test('fails closed when asExternalUri stays on localhost', async () => {
  const result = await createOffLanShareUrl({
    Uri: { parse: (value) => ({ value }) },
    env: {
      asExternalUri: async () => ({ toString: () => 'http://127.0.0.1:3000/' })
    }
  }, 'http://localhost:3000/');
  assert.equal(result.ok, false);
  assert.match(result.message, /off-LAN|tunnel/i);
});

test('returns the external URL when VS Code provides one', async () => {
  const result = await createOffLanShareUrl({
    Uri: { parse: (value) => ({ value }) },
    env: {
      asExternalUri: async () => ({ toString: () => 'https://share.example.dev/' })
    }
  }, 'http://localhost:3000/');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://share.example.dev/');
});
