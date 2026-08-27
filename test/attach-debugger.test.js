const assert = require('node:assert/strict');
const test = require('node:test');
const { canAttachDebugger } = require('../src/debug/attach-debugger');

test('debug attaches only to Runlist-started running processes with a PID', () => {
  assert.equal(canAttachDebugger({ name: 'App' }, {
    status: 'running',
    managed: true,
    pid: 4242
  }).ok, true);

  assert.match(canAttachDebugger({ name: 'App' }, {
    status: 'stopped',
    managed: true,
    pid: 4242
  }).reason, /only while Runlist is running/i);

  assert.match(canAttachDebugger({ name: 'App' }, {
    status: 'running',
    managed: false,
    pid: 4242,
    detected: true
  }).reason, /Runlist started/i);

  assert.match(canAttachDebugger({ name: 'App' }, {
    status: 'running',
    managed: true,
    pid: 0
  }).reason, /process ID/i);
});
