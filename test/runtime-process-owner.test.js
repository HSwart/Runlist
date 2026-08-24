const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  runtimeHostOwnerState,
  runtimeProcessOwnerDecision
} = require('../src/lifecycle/runtime-process-owner');

test('routes process ownership and port reservations through the shared evaluator', () => {
  for (const relativePath of [
    '../src/lifecycle/project-process.js',
    '../src/ports/port-gate.js'
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    assert.match(source, /require\(['"](?:\.\.\/lifecycle\/|\.\/)runtime-process-owner['"]\)/);
    assert.match(source, /runtimeProcessOwnerDecision\(\{/);
    assert.match(source, /runtimeHostOwnerState\(/);
  }
});

test('classifies exact, reused, absent, and unverifiable runtime owners', () => {
  const base = {
    currentPid: 404,
    expectedIdentity: '303:linux:1000',
    isProcessAlive: () => true,
    pid: 303,
    platform: 'linux'
  };

  assert.equal(runtimeProcessOwnerDecision({
    ...base,
    readProcessIdentity: () => '303:linux:1000'
  }), 'match');
  assert.equal(runtimeProcessOwnerDecision({
    ...base,
    readProcessIdentity: () => '303:linux:2000'
  }), 'mismatch');
  assert.equal(runtimeProcessOwnerDecision({
    ...base,
    isProcessAlive: () => false,
    readProcessIdentity: () => undefined
  }), 'absent');
  assert.equal(runtimeProcessOwnerDecision({
    ...base,
    readProcessIdentity: () => undefined
  }), 'unavailable');
  assert.equal(runtimeProcessOwnerDecision({
    ...base,
    expectedIdentity: undefined,
    isProcessAlive: () => false
  }), 'absent');
});

test('uses the captured identity for the current process without probing it again', () => {
  let reads = 0;
  assert.equal(runtimeProcessOwnerDecision({
    currentIdentity: '303:runtime:1000',
    currentPid: 303,
    expectedIdentity: '303:runtime:1000',
    isProcessAlive: () => true,
    pid: 303,
    platform: 'win32',
    readProcessIdentity: () => {
      reads += 1;
      return '303:runtime:2000';
    }
  }), 'match');
  assert.equal(reads, 0);
});

test('bounds identity probes with a cache while fresh safety checks bypass it', () => {
  const cache = new Map();
  let identity = '303:linux:1000';
  let reads = 0;
  const options = {
    cache,
    cacheTtlMs: 1000,
    currentPid: 404,
    expectedIdentity: '303:linux:1000',
    isProcessAlive: () => true,
    now: () => 5000,
    pid: 303,
    platform: 'linux',
    readProcessIdentity: () => {
      reads += 1;
      return identity;
    }
  };

  assert.equal(runtimeProcessOwnerDecision(options), 'match');
  identity = '303:linux:2000';
  assert.equal(runtimeProcessOwnerDecision(options), 'match');
  assert.equal(reads, 1);
  assert.equal(runtimeProcessOwnerDecision({ ...options, fresh: true }), 'mismatch');
  assert.equal(reads, 2);
});

test('combines identity and heartbeat into one conservative host-owner state', () => {
  assert.equal(runtimeHostOwnerState('match', {
    heartbeatAt: 1000,
    heartbeatTimeoutMs: 10000,
    now: 11000
  }), 'available');
  assert.equal(runtimeHostOwnerState('match', {
    heartbeatAt: 1000,
    heartbeatTimeoutMs: 10000,
    now: 11001
  }), 'absent');
  assert.equal(runtimeHostOwnerState('unavailable', {
    heartbeatAt: 0,
    heartbeatTimeoutMs: 10000,
    now: 50000
  }), 'uncertain');
  assert.equal(runtimeHostOwnerState('mismatch', {
    heartbeatAt: 50000,
    heartbeatTimeoutMs: 10000,
    now: 50000
  }), 'absent');
});
