const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createAtomicJsonRecordUpdater,
  readJsonRecord
} = require('../src/lifecycle/atomic-json-record');
const { writeFileAtomically } = require('../src/projects/project-store');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-atomic-record-'));
  const recordPath = path.join(directory, 'record.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    recordPath,
    records: createAtomicJsonRecordUpdater({
      maxAttempts: 3,
      processIdentity: `${process.pid}:runtime:2000`,
      retryMs: 1,
      wait: () => {},
      writeFileAtomically,
      ...options
    })
  };
}

test('updates or deletes a JSON record only after its current generation matches', (t) => {
  const { recordPath, records } = fixture(t);
  fs.writeFileSync(recordPath, JSON.stringify({ token: 'first', count: 1 }));

  assert.equal(records.update(
    recordPath,
    (current, fingerprint) => current?.token === 'wrong' && Boolean(fingerprint),
    (current) => ({ ...current, count: 2 })
  ), false);
  assert.deepEqual(readJsonRecord(recordPath), { token: 'first', count: 1 });
  assert.equal(fs.existsSync(`${recordPath}.update`), false);

  assert.equal(records.update(
    recordPath,
    (current, fingerprint) => current?.token === 'first' && Boolean(fingerprint),
    (current) => ({ ...current, count: 2 })
  ), true);
  assert.deepEqual(readJsonRecord(recordPath), { token: 'first', count: 2 });

  assert.equal(records.update(
    recordPath,
    (current) => current?.token === 'first'
  ), true);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(fs.existsSync(`${recordPath}.update`), false);
});

test('recovers an updater marker only when process identity proves PID reuse', (t) => {
  const { recordPath, records } = fixture(t, {
    isProcessAlive: () => true
  });
  fs.writeFileSync(recordPath, JSON.stringify({ token: 'current' }));
  fs.writeFileSync(`${recordPath}.update`, JSON.stringify({
    pid: process.pid,
    processIdentity: `${process.pid}:runtime:1000`
  }));

  assert.equal(records.update(
    recordPath,
    (current) => current?.token === 'current',
    (current) => ({ ...current, recovered: true })
  ), true);
  assert.deepEqual(readJsonRecord(recordPath), { token: 'current', recovered: true });
  assert.equal(fs.existsSync(`${recordPath}.update`), false);
});

test('times out without changing data when an updater marker is still owned', (t) => {
  let waits = 0;
  const message = 'record remains owned';
  const { recordPath, records } = fixture(t, {
    errorMessage: message,
    isProcessAlive: () => true,
    wait: () => { waits += 1; }
  });
  fs.writeFileSync(recordPath, JSON.stringify({ token: 'current' }));
  fs.writeFileSync(`${recordPath}.update`, JSON.stringify({
    pid: process.pid,
    processIdentity: `${process.pid}:runtime:2000`
  }));

  assert.throws(() => records.update(recordPath, () => true), new RegExp(message));
  assert.equal(waits, 3);
  assert.deepEqual(readJsonRecord(recordPath), { token: 'current' });
  assert.equal(fs.existsSync(`${recordPath}.update`), true);
});

test('cleans its updater marker when the atomic replacement fails', (t) => {
  const failure = new Error('disk unavailable');
  const { recordPath, records } = fixture(t, {
    writeFileAtomically: () => { throw failure; }
  });
  fs.writeFileSync(recordPath, JSON.stringify({ token: 'current' }));

  assert.throws(() => records.update(
    recordPath,
    (current) => current?.token === 'current',
    (current) => ({ ...current, changed: true })
  ), failure);
  assert.deepEqual(readJsonRecord(recordPath), { token: 'current' });
  assert.equal(fs.existsSync(`${recordPath}.update`), false);
});
