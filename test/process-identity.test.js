const assert = require('node:assert/strict');
const test = require('node:test');

const {
  currentProcessIdentity,
  processIdentityDecision,
  readProcessIdentity,
  readProcessIdentitySync,
  stableProcessIdentity
} = require('../src/lifecycle/process-identity');

test('uses one canonical Linux identity for synchronous and asynchronous capture', async () => {
  const synchronous = readProcessIdentitySync(303, 'linux', {
    readFileSync: () => {
      const fields = Array(20).fill('0');
      fields[18] = '987654';
      return `303 (node) S ${fields.join(' ')}`;
    }
  });
  const asynchronous = await readProcessIdentity(303, 'linux', {
    runFile: async () => ' 303 1 303 Sun Aug 16 12:00:00 2026 00:01.00 1024',
    readLinuxStartTicks: async () => '987654'
  });

  assert.equal(synchronous, '303:linux:987654');
  assert.equal(asynchronous, synchronous);
});

test('compares canonical identities while remaining safe during persisted-format upgrades', () => {
  assert.equal(
    processIdentityDecision('303:987654', '303:linux:987654', 'linux', 303),
    'match'
  );
  assert.equal(
    processIdentityDecision('303:987654', '303:linux:987655', 'linux', 303),
    'mismatch'
  );
  assert.equal(
    processIdentityDecision('303:runtime:1000', '303:linux:987654', 'linux', 303),
    'unavailable'
  );
  assert.equal(
    processIdentityDecision('303:runtime:1000', '303:runtime:1001', 'darwin', 303),
    'unavailable'
  );
  assert.equal(
    processIdentityDecision(
      '303:runtime:1000',
      '303:runtime:1001',
      'darwin',
      303,
      { allowRuntime: true }
    ),
    'mismatch'
  );
  assert.equal(
    processIdentityDecision(
      '303:Mon Jan  1 00:00:00 2024',
      '303:darwin:v2:2024-01-01T00:00:00:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'darwin',
      303
    ),
    'unavailable'
  );
});

test('validates and captures current identity through the shared boundary', () => {
  assert.equal(stableProcessIdentity('303:linux:987654'), true);
  assert.equal(stableProcessIdentity(' 303:linux:987654 '), false);
  assert.equal(currentProcessIdentity({
    pid: 303,
    platform: 'linux',
    readFileSync: () => { throw new Error('unavailable'); },
    allowRuntimeFallback: false
  }), undefined);
  assert.equal(currentProcessIdentity({
    pid: 303,
    platform: 'linux',
    readFileSync: () => { throw new Error('unavailable'); },
    allowRuntimeFallback: true,
    now: () => 5000,
    uptime: () => 2
  }), '303:runtime:3000');
  const fallback = currentProcessIdentity({
    platform: 'linux',
    readFileSync: () => { throw new Error('unavailable'); },
    allowRuntimeFallback: true
  });
  assert.equal(currentProcessIdentity({
    platform: 'linux',
    readFileSync: () => {
      const fields = Array(20).fill('0');
      fields[18] = '987654';
      return `${process.pid} (node) S ${fields.join(' ')}`;
    },
    allowRuntimeFallback: true
  }), fallback);
});
