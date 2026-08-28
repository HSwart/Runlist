'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');
const {
  projectDisplayedStatus,
  projectPrimaryStatusCode,
  projectStatusDetailText
} = require('../media/project-status-display');
const { projectPrimaryAction } = require('../media/project-actions');

test('delete while starting cancels the start before removing the saved project', () => {
  const source = readShippedHostSource();
  const deleteProject = source.indexOf('async deleteProject(id)');
  const cancelStart = source.indexOf('if (this.startAttempts.has(id))', deleteProject);
  const cancelBlock = source.slice(cancelStart, cancelStart + 650);
  assert.match(cancelBlock, /startAttempts\.delete\(id\)/);
  assert.match(cancelBlock, /if \(!this\.processes\.has\(id\)\)/);
  assert.match(cancelBlock, /startCancelledWithoutProcess = true/);
  assert.match(cancelBlock, /releaseStartReservation\(id\)/);
  assert.match(cancelBlock, /else if \(!startCancelledWithoutProcess/);

  const startProject = source.indexOf('async startProject(id, options = {})');
  const preSpawnCheckpoint = source.indexOf('if (this.startAttempts.get(id) !== attempt)', startProject);
  const spawn = source.indexOf('spawnProjectCommand(launchCommand', preSpawnCheckpoint);
  assert.ok(preSpawnCheckpoint >= startProject);
  assert.ok(preSpawnCheckpoint < spawn);
});

test('stop while starting terminates a live process handle instead of orphaning it', () => {
  const source = readShippedHostSource();
  const execute = source.indexOf('async executeStopProjectProcess(id, projectSnapshot, options = {})');
  const executeStartAttempt = source.indexOf('if (this.startAttempts.has(id))', execute);
  const executeBlock = source.slice(executeStartAttempt, executeStartAttempt + 450);
  assert.match(executeBlock, /startAttempts\.delete\(id\)/);
  assert.match(executeBlock, /if \(!this\.processes\.has\(id\)\)/);
  assert.match(executeBlock, /return true;/);
  assert.ok(
    source.indexOf('if (this.processes.has(id))', executeStartAttempt) > executeStartAttempt
    || source.indexOf('return this.stopOwnedProjectProcess', execute) > execute
  );

  const owned = source.indexOf('async stopOwnedProjectProcess(id, project, options = {})');
  const ownedStartAttempt = source.indexOf('if (this.startAttempts.has(id))', owned);
  const ownedBlock = source.slice(ownedStartAttempt, source.indexOf('if (this.processes.has(id))', ownedStartAttempt) + 200);
  assert.match(ownedBlock, /startAttempts\.delete\(id\)/);
  assert.match(ownedBlock, /terminateTrackedProcess/);
});

test('getProjectStatus and waitUntilStopped treat a live local handle as not stopped', () => {
  const source = readShippedHostSource();
  const getStatus = source.slice(
    source.indexOf('getProjectStatus(id)'),
    source.indexOf('getProjectStatus(id)') + 550
  );
  assert.match(getStatus, /processes\.has\(id\)/);
  assert.match(getStatus, /status === 'stopped'/);

  const lifecycle = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'lifecycle', 'project-lifecycle.js'),
    'utf8'
  );
  const wait = lifecycle.slice(
    lifecycle.indexOf('async waitUntilStopped'),
    lifecycle.indexOf('async waitUntilServicesStopped')
  );
  assert.match(wait, /processes\?\.has|host\.processes/);
});

test('not-responding is not labeled Running on the default row', () => {
  assert.equal(projectPrimaryStatusCode({ status: 'not-responding' }), 'not-responding');
  assert.equal(
    projectDisplayedStatus({ name: 'App', status: 'not-responding' }),
    'Web service not responding'
  );
  assert.notEqual(projectDisplayedStatus({ name: 'App', status: 'not-responding' }), 'Running');
});

test('compose start is disabled when composeStartBlocked is set', () => {
  const action = projectPrimaryAction({
    name: 'Api',
    status: 'stopped',
    composeStartBlocked: true,
    composeStartBlockedReason: 'Docker is not ready'
  });
  assert.equal(action.action, 'start');
  assert.equal(action.disabled, true);
  assert.match(action.label, /Docker is not ready|unavailable/i);
});

test('compose start block keeps Stop available for a running project', () => {
  const action = projectPrimaryAction({
    name: 'Api',
    status: 'running',
    composeStartBlocked: true,
    composeStartBlockedReason: 'Docker is not ready'
  });
  assert.equal(action.action, 'stop');
  assert.equal(action.disabled, false);
  assert.equal(action.mode, 'stop');
  assert.match(action.label, /Stop Api/);
});

test('compose start block keeps Stop available while not-responding', () => {
  const action = projectPrimaryAction({
    name: 'Api',
    status: 'not-responding',
    composeStartBlocked: true,
    composeStartBlockedReason: 'Docker is not ready'
  });
  assert.equal(action.action, 'stop');
  assert.equal(action.mode, 'stop');
});
