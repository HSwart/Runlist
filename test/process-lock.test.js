const assert = require('node:assert/strict');
const test = require('node:test');
const {
  processLockOwnerDecision,
  processLockRecordIsAbandoned,
  processPresence
} = require('../src/lifecycle/process-lock');

test('classifies exact, reused, missing, and unverifiable lock owners', () => {
  const record = {
    pid: 303,
    processIdentity: '303:linux:1000'
  };
  const options = {
    currentPid: 404,
    isProcessAlive: () => true,
    platform: 'linux'
  };

  assert.equal(processLockOwnerDecision(record, {
    ...options,
    readProcessIdentitySync: () => '303:linux:1000'
  }), 'active');
  assert.equal(processLockOwnerDecision(record, {
    ...options,
    readProcessIdentitySync: () => '303:linux:2000'
  }), 'absent');
  assert.equal(processLockOwnerDecision(record, {
    ...options,
    isProcessAlive: () => false
  }), 'absent');
  assert.equal(processLockOwnerDecision(record, {
    ...options,
    readProcessIdentitySync: () => undefined
  }), 'uncertain');
  assert.equal(processLockOwnerDecision({ pid: 303 }, options), 'uncertain');
});

test('accepts runtime identity only for explicitly scoped transient locks', () => {
  const record = { pid: 303, processIdentity: '303:runtime:1000' };
  const options = {
    currentPid: 303,
    currentProcessIdentity: '303:runtime:2000',
    isProcessAlive: () => true,
    platform: 'win32'
  };

  assert.equal(processLockRecordIsAbandoned(record, options), false);
  assert.equal(processLockRecordIsAbandoned(record, {
    ...options,
    allowRuntime: true
  }), true);
});

test('treats unexpected process-probe failures as uncertain instead of absent', () => {
  assert.equal(processPresence(303, {
    kill: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }
  }), 'uncertain');
  assert.equal(processLockOwnerDecision({
    pid: 303,
    processIdentity: '303:linux:1000'
  }, {
    kill: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    platform: 'linux',
    readProcessIdentitySync: () => '303:linux:2000'
  }), 'uncertain');
});

test('caches an expensive identity probe for one lock acquisition attempt', () => {
  const identityCache = new Map();
  let reads = 0;
  const options = {
    currentPid: 404,
    identityCache,
    isProcessAlive: () => true,
    platform: 'win32',
    readProcessIdentitySync: () => {
      reads += 1;
      throw new Error('identity probe timed out');
    }
  };
  const record = { pid: 303, processIdentity: '303:1000' };

  assert.equal(processLockOwnerDecision(record, options), 'uncertain');
  assert.equal(processLockOwnerDecision(record, options), 'uncertain');
  assert.equal(reads, 1);
});
