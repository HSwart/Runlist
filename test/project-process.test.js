const assert = require('node:assert/strict');
const test = require('node:test');
const { terminateTrackedProcess } = require('../project-process');

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
