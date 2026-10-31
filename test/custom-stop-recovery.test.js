const assert = require('node:assert/strict');
const test = require('node:test');
const { customStopPostcondition, stopHonestyMessage } = require('../src/host/host-helpers');

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

test('describes Stop honesty without claiming Stopped', () => {
  assert.equal(stopHonestyMessage({ processActive: true, openPorts: [3000] }), 'Stop failed');
  assert.equal(stopHonestyMessage({
    processActive: false,
    openPorts: [3000],
    webPort: 3000
  }), 'Port :3000 is still up');
  assert.equal(stopHonestyMessage({ processActive: false, openPorts: [] }), '');
});
