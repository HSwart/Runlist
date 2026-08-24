const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withExclusiveJsonLock } = require('../src/lifecycle/exclusive-json-lock');

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-exclusive-lock-'));
  const lockPath = path.join(directory, 'shared.lock');
  const events = [];
  const options = {
    createRecord: (token, createdAt) => ({ pid: 101, processIdentity: '101:1000', createdAt, token }),
    diagnose: (event, details) => events.push({ event, ...details }),
    heldLocks: new Set(),
    lockKind: 'test-lock',
    lockPath,
    maxAttempts: 3,
    now: () => 1000,
    observe: () => {
      try {
        return fs.readFileSync(lockPath, 'utf8');
      } catch {
        return undefined;
      }
    },
    ownerIsAbandoned: (record) => record.pid === 202,
    randomUUID: () => 'owned-token',
    recordFromObservation: (observed) => {
      try {
        return JSON.parse(observed);
      } catch {
        return undefined;
      }
    },
    removeInvalid: () => false,
    removeObserved: (observed, canRemove) => {
      if (options.observe() !== observed) {
        return false;
      }
      const record = options.recordFromObservation(observed);
      if (!canRemove(record)) {
        return false;
      }
      fs.unlinkSync(lockPath);
      return true;
    },
    retryMs: 0,
    timeoutError: () => Object.assign(new Error('busy'), { code: 'BUSY' }),
    wait: () => undefined,
    ...overrides
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { events, lockPath, options };
}

test('acquires, reenters, and releases one exact lock generation', (t) => {
  const { events, lockPath, options } = fixture(t);

  assert.equal(withExclusiveJsonLock(options, () => {
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'owned-token');
    return withExclusiveJsonLock(options, () => 'result');
  }), 'result');
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(events, [{
    event: 'lock.acquired',
    reasonCode: 'immediate',
    attemptCount: 1,
    lockKind: 'test-lock'
  }]);
});

test('recovers only an abandoned observed generation before acquiring', (t) => {
  const { events, lockPath, options } = fixture(t);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 202, token: 'stale-token' }));

  assert.equal(withExclusiveJsonLock(options, () => true), true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(events.map(({ event, reasonCode, attemptCount }) => ({
    event,
    reasonCode,
    attemptCount
  })), [
    { event: 'lock.stale-recovered', reasonCode: 'owner-absent', attemptCount: 1 },
    { event: 'lock.acquired', reasonCode: 'after-contention', attemptCount: 2 }
  ]);
});

test('times out without removing a live or uncertain lock', (t) => {
  const { events, lockPath, options } = fixture(t);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 303, token: 'live-token' }));

  assert.throws(() => withExclusiveJsonLock(options, () => undefined), (error) => error.code === 'BUSY');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'live-token');
  assert.equal(events.at(-1).event, 'lock.timeout');
  assert.equal(events.at(-1).attemptCount, 3);
});

test('waits when an abandoned observation changes before removal', (t) => {
  let waits = 0;
  const { lockPath, options } = fixture(t, {
    maxAttempts: 1,
    removeObserved: () => false,
    wait: () => { waits += 1; }
  });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 202, token: 'stale-token' }));

  assert.throws(() => withExclusiveJsonLock(options, () => undefined), (error) => error.code === 'BUSY');
  assert.equal(waits, 1);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'stale-token');
});

test('recovers a stale invalid record only through the supplied policy', (t) => {
  const { events, lockPath, options } = fixture(t, {
    removeInvalid: () => {
      fs.unlinkSync(lockPath);
      return true;
    }
  });
  fs.writeFileSync(lockPath, '{"pid":');

  assert.equal(withExclusiveJsonLock(options, () => 'recovered'), 'recovered');
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(events.map(({ event, reasonCode }) => ({ event, reasonCode })), [
    { event: 'lock.stale-recovered', reasonCode: 'invalid-record' },
    { event: 'lock.acquired', reasonCode: 'after-contention' }
  ]);
});

test('preserves an operation error when exact release also fails', (t) => {
  const primary = new Error('operation failed');
  const cleanup = new Error('release failed');
  const { options } = fixture(t, {
    removeObserved: () => { throw cleanup; }
  });

  assert.throws(() => withExclusiveJsonLock(options, () => { throw primary; }), (error) => (
    error === primary && error.cleanupErrors?.[0] === cleanup
  ));
});
