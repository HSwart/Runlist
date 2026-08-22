const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findListeningProcesses,
  parseLsofListeners,
  parseSsListeners,
  parseWindowsNetstatListeners,
  terminateListenerProcess,
  windowsProcessDetailsScript
} = require('../src/ports/port-process');

test('parses exact Windows netstat LISTENING rows without requiring elevated TCP inspection', () => {
  const output = [
    '  TCP    0.0.0.0:4280           0.0.0.0:0              LISTENING       120',
    '  TCP    [::]:4280              [::]:0                 LISTENING       120',
    '  TCP    127.0.0.1:7071         0.0.0.0:0              LISTENING       240',
    '  TCP    127.0.0.1:7071         127.0.0.1:51000        ESTABLISHED     240',
    '  TCP    0.0.0.0:9999           0.0.0.0:0              LISTENING       360'
  ].join('\n');

  assert.deepEqual(parseWindowsNetstatListeners(output, [4280, 7071]), [
    { port: 4280, pid: 120, name: 'Unknown process' },
    { port: 7071, pid: 240, name: 'Unknown process' }
  ]);
});

test('parses lsof field output without confusing IPv6 addresses for ports', () => {
  const output = [
    'p120',
    'cnode',
    'n127.0.0.1:4280',
    'n[::1]:4280',
    'p240',
    'cpython',
    'n*:7071',
    'p360',
    'cother',
    'n*:9999'
  ].join('\n');

  assert.deepEqual(parseLsofListeners(output, [4280, 7071]), [
    { port: 4280, pid: 120, name: 'node' },
    { port: 7071, pid: 240, name: 'python' }
  ]);
});

test('parses Linux ss listeners and keeps every exact owning process', () => {
  const output = [
    'LISTEN 0 511 127.0.0.1:4280 0.0.0.0:* users:(("node",pid=120,fd=20))',
    'LISTEN 0 511 [::]:7071 [::]:* users:(("python",pid=240,fd=7),("python",pid=241,fd=7))',
    'LISTEN 0 511 0.0.0.0:9999 0.0.0.0:* users:(("other",pid=360,fd=3))'
  ].join('\n');

  assert.deepEqual(parseSsListeners(output, [4280, 7071]), [
    { port: 4280, pid: 120, name: 'node' },
    { port: 7071, pid: 240, name: 'python' },
    { port: 7071, pid: 241, name: 'python' }
  ]);
});

test('resolves Windows listeners and adds identity through a targeted process query', async () => {
  const listeners = await findListeningProcesses([4280, 7071], {
    platform: 'win32',
    runFile: async (file) => {
      if (file === 'netstat.exe') {
        return [
          'TCP 0.0.0.0:4280 0.0.0.0:0 LISTENING 120',
          'TCP 127.0.0.1:7071 0.0.0.0:0 LISTENING 240'
        ].join('\n');
      }
      assert.equal(file, 'powershell.exe');
      return JSON.stringify([
        { pid: 120, name: 'node', startedAt: '638900000000000000' },
        { pid: 240, name: 'func', startedAt: '638900000000000100' }
      ]);
    }
  });

  assert.deepEqual(listeners, [
    { port: 4280, pid: 120, name: 'node', identity: '120:638900000000000000' },
    { port: 7071, pid: 240, name: 'func', identity: '240:638900000000000100' }
  ]);
});

test('isolates inaccessible Windows process identities per listener', () => {
  const script = windowsProcessDetailsScript([120, 240]);
  assert.match(script, /foreach\(\$ownerProcessId/);
  assert.match(script, /try \{/);
  assert.match(script, /catch \{ continue \}/);
});

test('falls back to Linux ss and independently identifies each listener process', async () => {
  const listeners = await findListeningProcesses([4280], {
    platform: 'linux',
    runFile: async (file) => {
      if (file === 'lsof') {
        const error = new Error('lsof is unavailable');
        error.code = 'ENOENT';
        throw error;
      }
      assert.equal(file, 'ss');
      return 'LISTEN 0 511 127.0.0.1:4280 0.0.0.0:* users:(("node",pid=120,fd=20))';
    },
    readProcessIdentity: async (pid) => `${pid}:1750000000000`
  });

  assert.deepEqual(listeners, [
    { port: 4280, pid: 120, name: 'node', identity: '120:1750000000000' }
  ]);
});

test('refuses termination when the exact process identity has changed', async () => {
  const signals = [];
  await assert.rejects(
    terminateListenerProcess({ pid: 120, identity: '120:first' }, {
      platform: 'linux',
      readProcessIdentity: async () => '120:replacement',
      kill: (pid, signal) => signals.push([pid, signal])
    }),
    /identity changed/i
  );
  assert.deepEqual(signals, []);
});

test('accepts a saved project-root race only when that exact target already exited', async () => {
  const signals = [];
  await terminateListenerProcess({ pid: 80, identity: '80:first' }, {
    platform: 'linux',
    allowMissing: true,
    readProcessIdentity: async () => undefined,
    kill: (pid, signal) => signals.push([pid, signal])
  });
  assert.deepEqual(signals, []);
});

test('terminates the exact Windows listener tree after identity validation', async () => {
  const terminated = [];
  await terminateListenerProcess({ pid: 120, identity: '120:first' }, {
    platform: 'win32',
    readProcessIdentity: async () => '120:first',
    terminateProcessTree: async (pid, options) => terminated.push([pid, options.platform])
  });

  assert.deepEqual(terminated, [[120, 'win32']]);
});

test('terminates a verified Runlist process tree on macOS', async () => {
  const terminated = [];
  await terminateListenerProcess({ pid: 120, identity: '120:first' }, {
    platform: 'darwin',
    terminateTree: true,
    readProcessIdentity: async () => '120:first',
    terminateProcessTree: async (pid, options) => terminated.push([pid, options.platform]),
    kill: () => {
      throw new Error('owned process trees must use process-group termination');
    }
  });

  assert.deepEqual(terminated, [[120, 'darwin']]);
});

test('terminates an exact POSIX listener PID without assuming it leads a process group', async () => {
  const signals = [];
  let alive = true;
  await terminateListenerProcess({ pid: 120, identity: '120:first' }, {
    platform: 'linux',
    readProcessIdentity: async () => '120:first',
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
    isProcessAlive: () => alive,
    delay: async () => undefined
  });

  assert.deepEqual(signals, [[120, 'SIGTERM']]);
});

test('revalidates a POSIX listener identity before escalating to SIGKILL', async () => {
  const signals = [];
  let identityRead = 0;
  await assert.rejects(
    terminateListenerProcess({ pid: 120, identity: '120:first' }, {
      platform: 'darwin',
      graceMs: 0,
      readProcessIdentity: async () => {
        identityRead += 1;
        return identityRead === 1 ? '120:first' : '120:replacement';
      },
      kill: (pid, signal) => signals.push([pid, signal]),
      isProcessAlive: () => true,
      delay: async () => undefined
    }),
    /force close.*identity changed/i
  );

  assert.deepEqual(signals, [[120, 'SIGTERM']]);
});

test('escalates an unchanged POSIX listener after the grace period', async () => {
  const signals = [];
  let alive = true;
  await terminateListenerProcess({ pid: 120, identity: '120:first' }, {
    platform: 'linux',
    graceMs: 0,
    readProcessIdentity: async () => '120:first',
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') {
        alive = false;
      }
    },
    isProcessAlive: () => alive,
    delay: async () => undefined
  });

  assert.deepEqual(signals, [[120, 'SIGTERM'], [120, 'SIGKILL']]);
});
