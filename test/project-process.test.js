const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupTrackedProcessForDeletion,
  terminateTrackedProcess
} = require('../project-process');

test('terminates and forgets only the requested tracked process', () => {
  const signals = [];
  const otherProcess = { kill() {} };
  const processes = new Map([
    ['review-required', { kill: (signal) => signals.push(signal) }],
    ['other', otherProcess]
  ]);

  assert.equal(terminateTrackedProcess(processes, 'review-required'), true);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(processes.has('review-required'), false);
  assert.equal(processes.get('other'), otherProcess);
  assert.equal(terminateTrackedProcess(processes, 'missing'), false);
});

test('uses only an approved post-confirmation snapshot during deletion', () => {
  const signals = [];
  const stopCalls = [];
  const processes = new Map([
    ['unreviewed', { kill: (signal) => signals.push(signal) }],
    ['deleted-elsewhere', { kill: (signal) => signals.push(signal) }],
    ['approved', { kill() {} }]
  ]);
  const approvedProject = { id: 'approved', reviewRequired: false, stopCommand: 'npm stop' };

  cleanupTrackedProcessForDeletion(
    processes,
    'unreviewed',
    { id: 'unreviewed', reviewRequired: true },
    (project) => stopCalls.push(project)
  );
  cleanupTrackedProcessForDeletion(
    processes,
    'deleted-elsewhere',
    undefined,
    (project) => stopCalls.push(project)
  );
  cleanupTrackedProcessForDeletion(
    processes,
    'approved',
    approvedProject,
    (project) => stopCalls.push(project)
  );

  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
  assert.deepEqual(stopCalls, [approvedProject]);
  assert.equal(processes.has('unreviewed'), false);
  assert.equal(processes.has('deleted-elsewhere'), false);
  assert.equal(processes.has('approved'), true);
});
