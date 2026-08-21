const assert = require('node:assert/strict');
const test = require('node:test');
const { customStopPostcondition } = require('../custom-stop-recovery');

test('requires a successful command and every verifiable postcondition', () => {
  assert.equal(customStopPostcondition({
    commandSucceeded: true,
    hasConfiguredServices: true,
    hadTrackedOwnership: true,
    ownershipStopped: true,
    servicesStopped: true
  }), 'complete');
});

test('reports command failures even when the command changed lifecycle state', () => {
  assert.equal(customStopPostcondition({
    commandSucceeded: false,
    hasConfiguredServices: true,
    hadTrackedOwnership: true,
    ownershipStopped: true,
    servicesStopped: true
  }), 'command-failed');
});

test('reports partial completion without selecting another stop action', () => {
  assert.equal(customStopPostcondition({
    commandSucceeded: true,
    hasConfiguredServices: true,
    hadTrackedOwnership: true,
    ownershipStopped: false,
    servicesStopped: true
  }), 'partial');
  assert.equal(customStopPostcondition({
    commandSucceeded: true,
    hasConfiguredServices: true,
    hadTrackedOwnership: true,
    ownershipStopped: true,
    servicesStopped: false
  }), 'partial');
});

test('does not claim success without a lifecycle target to verify', () => {
  assert.equal(customStopPostcondition({
    commandSucceeded: true,
    hasConfiguredServices: false,
    hadTrackedOwnership: false,
    ownershipStopped: true,
    servicesStopped: true
  }), 'unverifiable');
});
