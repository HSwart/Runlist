'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EMPTY_START_COMMAND_DETAIL,
  HUNG_START_DETAIL,
  emptyStartCommandDetail,
  hungStartFailureDetail,
  hungStartShouldFail,
  hungStoppingShouldResolve,
  isEmptyStartCommand
} = require('../src/lifecycle/lifecycle-honesty');
const { projectStartFailureText, projectStopFailureText, projectDisplayedStatus } = require('../media/project-status-display');
const { readShippedHostSource } = require('./helpers/extension-source');
const { ProjectLifecycleCoordinator } = require('../src/lifecycle/project-lifecycle');

test('fails hung start only when no process is past the start bound', () => {
  assert.equal(hungStartShouldFail({
    processActive: true,
    readinessTimedOut: true
  }), false);
  assert.equal(hungStartShouldFail({
    processActive: false,
    readinessTimedOut: true
  }), true);
  assert.equal(hungStartShouldFail({
    processActive: false,
    startAttemptAgeMs: 29999,
    startBoundMs: 30000
  }), false);
  assert.equal(hungStartShouldFail({
    processActive: false,
    startAttemptAgeMs: 30000,
    startBoundMs: 30000
  }), true);
  assert.equal(hungStartFailureDetail(), HUNG_START_DETAIL);
});

test('treats blank start commands as missing', () => {
  assert.equal(isEmptyStartCommand(''), true);
  assert.equal(isEmptyStartCommand('   '), true);
  assert.equal(isEmptyStartCommand(undefined), true);
  assert.equal(isEmptyStartCommand('npm start'), false);
  assert.equal(emptyStartCommandDetail(), EMPTY_START_COMMAND_DETAIL);
});

test('resolves hung stopping after the stop bound', () => {
  assert.equal(hungStoppingShouldResolve({
    processActive: false,
    portsOpen: false
  }), 'stopped');
  assert.equal(hungStoppingShouldResolve({
    processActive: true,
    portsOpen: false,
    stoppingAgeMs: 1000,
    stopBoundMs: 20000
  }), 'stopping');
  assert.equal(hungStoppingShouldResolve({
    processActive: true,
    portsOpen: false,
    stoppingAgeMs: 20000,
    stopBoundMs: 20000
  }), 'stop-failed');
  assert.equal(hungStoppingShouldResolve({
    processActive: false,
    portsOpen: true,
    stoppingAgeMs: 20000,
    stopBoundMs: 20000
  }), 'stop-failed');
});

test('shows start failure text on stopped and port-conflict rows', () => {
  assert.equal(projectStartFailureText({
    status: 'stopped',
    failureSummary: { message: HUNG_START_DETAIL }
  }), HUNG_START_DETAIL);
  assert.equal(projectStartFailureText({
    status: 'stopped',
    failureSummary: { message: EMPTY_START_COMMAND_DETAIL }
  }), EMPTY_START_COMMAND_DETAIL);
  assert.equal(projectStartFailureText({
    status: 'port-in-use',
    failureSummary: { message: 'Owner did not stop' }
  }), 'Owner did not stop');
  assert.equal(projectDisplayedStatus({
    status: 'stopped',
    failureSummary: { message: HUNG_START_DETAIL }
  }), HUNG_START_DETAIL);
});

test('shows stop-failed line 2 after leaving Stopping', () => {
  assert.equal(projectStopFailureText({
    status: 'stopping',
    stopFailure: 'Stop failed'
  }), '');
  assert.equal(projectStopFailureText({
    status: 'running',
    stopFailure: 'Stop failed'
  }), 'Stop failed');
  assert.equal(projectDisplayedStatus({
    status: 'running',
    stopFailure: 'Stop failed'
  }), 'Stop failed');
});

test('wires hung start, empty command, handoff, and force-close honesty into the host', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = readShippedHostSource();
  const lifecycle = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lifecycle', 'project-lifecycle.js'),
    'utf8'
  );
  assert.match(source, /hungStartShouldFail/);
  assert.match(source, /hungStartFailureDetail|HUNG_START_DETAIL/);
  assert.match(source, /isEmptyStartCommand/);
  assert.match(source, /emptyStartCommandDetail|EMPTY_START_COMMAND_DETAIL/);
  assert.match(source, /hungStoppingShouldResolve/);
  assert.match(lifecycle, /showStartFailure\([\s\S]*failureMessage/);
  assert.match(source, /still-open[\s\S]{0,400}showStartFailure/);
});

test('handoff failure records a start failure on the requested row', async () => {
  const failures = [];
  const host = {
    projects: [{ id: 'beta', name: 'Beta', reviewRequired: false }],
    handoffProjectIds: new Set(),
    processOwnership: {
      reserve: () => undefined,
      release: () => undefined,
      snapshot: () => new Map()
    },
    portReservations: {
      conflicts: () => []
    },
    showStartFailure(project, details) {
      failures.push({ id: project.id, details });
    },
    focusTarget: undefined,
    renderProjectList() {},
    refreshProjectStatuses() {},
    waitForProjectStopCompletion: async () => false,
    stopProject: async () => false,
    startProject: async () => true
  };
  const lifecycle = new ProjectLifecycleCoordinator(host, {
    servicePortStatus: async () => ({ anyOpen: false, openPorts: [] }),
    showErrorMessage() {}
  });
  // Force the failure path through handoffOperation by stubbing handoffProjectSafely via reserve false
  host.processOwnership.reserve = () => ({ kind: 'local' });
  const result = await lifecycle.handoffOperation('beta');
  assert.equal(result, false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 'beta');
  assert.match(String(failures[0].details.detail || ''), /already starting or running|cannot safely verify/i);
});
