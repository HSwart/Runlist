const assert = require('node:assert/strict');
const test = require('node:test');
const { customStopFallbackAction } = require('../custom-stop-recovery');

test('reconciles a failed custom stop when every configured service is already down', () => {
  assert.equal(customStopFallbackAction({
    commandSucceeded: false,
    hasConfiguredServices: true,
    ownershipStopped: true,
    servicesStopped: true
  }), 'complete');
});

test('offers confirmed port recovery when a custom stop leaves configured services open', () => {
  assert.equal(customStopFallbackAction({
    commandSucceeded: false,
    hasConfiguredServices: true,
    ownershipStopped: true,
    servicesStopped: false
  }), 'recover-ports');
});

test('uses exact Runlist ownership when only the launched process remains', () => {
  assert.equal(customStopFallbackAction({
    commandSucceeded: false,
    hasConfiguredServices: true,
    ownershipStopped: false,
    servicesStopped: true
  }), 'stop-owned-process');
});

test('does not hide an unverifiable custom stop failure without service metadata', () => {
  assert.equal(customStopFallbackAction({
    commandSucceeded: false,
    hasConfiguredServices: false,
    ownershipStopped: true,
    servicesStopped: true
  }), 'report-command-failure');
});

test('accepts a successful custom stop after ownership and services are down', () => {
  assert.equal(customStopFallbackAction({
    commandSucceeded: true,
    hasConfiguredServices: false,
    ownershipStopped: true,
    servicesStopped: true
  }), 'complete');
});
