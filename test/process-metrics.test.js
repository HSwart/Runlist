const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  OwnedProcessMetrics,
  parseCpuTime,
  parseWindowsProcessOutput,
  readRootProcess,
  readOwnedProcessTree,
  windowsProcessScript
} = require('../src/lifecycle/process-metrics');
const { HttpResponseHistory, RuntimePulseHistory } = require('../src/lifecycle/runtime-pulse');
const { readShippedHostSource } = require('./helpers/extension-source');

function row(pid, identity, cpuSeconds, memoryBytes) {
  return { pid, identity, cpuSeconds, memoryBytes };
}

function expectedDarwinIdentity(pid, startedAt, details) {
  const canonical = [
    'runlist-darwin-process',
    'v2',
    String(pid),
    startedAt,
    String(details.uid),
    String(details.processGroupId),
    String(details.sessionId).toLowerCase(),
    details.command
  ].map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('');
  return `${pid}:darwin:v2:${startedAt}:${crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')}`;
}

test('reads a Windows root process identity when CIM access is denied', async () => {
  const expected = {
    pid: 55,
    parentPid: 0,
    identity: '55:638912345678901234',
    cpuSeconds: 1.25,
    memoryBytes: 4096
  };
  const runFile = async (_command, args, options) => {
    const script = args.at(-1);
    if (script.includes('Get-CimInstance')) {
      throw new Error('Access denied');
    }
    if (script.includes('Get-Process')) {
      if (options.timeout < 10000) {
        throw new Error('Process identity query timed out');
      }
      return JSON.stringify({
        pid: 55,
        parentPid: 0,
        startedAt: '638912345678901234',
        cpuSeconds: 1.25,
        memoryBytes: 4096
      });
    }
    throw new Error('Unexpected Windows process query');
  };

  let actual;
  try {
    actual = await readRootProcess(55, 'win32', { runFile });
  } catch (error) {
    actual = { error: error.message };
  }

  assert.deepEqual(actual, expected);
});

test('aggregates current CPU and memory only across the tracked process tree', async () => {
  let now = 1000;
  let sample = [
    row(100, '100:start', 2, 10 * 1024 * 1024),
    row(101, '101:start', 1, 20 * 1024 * 1024)
  ];
  const metrics = new OwnedProcessMetrics({
    now: () => now,
    readRoot: async () => sample[0],
    readTree: async () => sample
  });
  metrics.track('project', 100);

  assert.deepEqual(await metrics.sample('project', 100), {
    available: true,
    cpuPercent: undefined,
    memoryBytes: 30 * 1024 * 1024,
    processCount: 2
  });

  now = 6000;
  sample = [
    row(100, '100:start', 3, 12 * 1024 * 1024),
    row(101, '101:start', 1.5, 22 * 1024 * 1024),
    row(102, '102:new', 20, 5 * 1024 * 1024)
  ];
  assert.deepEqual(await metrics.sample('project', 100), {
    available: true,
    cpuPercent: 30,
    memoryBytes: 39 * 1024 * 1024,
    processCount: 3
  });
});

test('stops reporting when the root PID identity changes or tracking ends', async () => {
  let root = row(200, '200:first', 1, 1024);
  const metrics = new OwnedProcessMetrics({
    readRoot: async () => root,
    readTree: async () => [root]
  });
  metrics.track('project', 200);
  await metrics.sample('project', 200);

  root = row(200, '200:reused', 0, 2048);
  assert.deepEqual(await metrics.sample('project', 200), {
    available: false,
    message: 'Resource use stopped because process ownership changed.'
  });
  assert.equal((await metrics.sample('project', 200)).available, false);

  metrics.track('project', 201);
  metrics.untrack('project');
  assert.equal((await metrics.sample('project', 201)).available, false);
});

test('reports unavailable metrics when an owned process exits or the platform cannot sample it', async () => {
  let rows = [row(210, '210:start', 1, 1024)];
  const metrics = new OwnedProcessMetrics({
    readRoot: async () => rows[0],
    readTree: async () => rows
  });
  metrics.track('exited', 210);
  await metrics.sample('exited', 210);
  rows = [];
  assert.equal((await metrics.sample('exited', 210)).available, false);

  const unsupported = new OwnedProcessMetrics({
    readRoot: async () => { throw new Error('command unavailable'); },
    readTree: async () => []
  });
  unsupported.track('unsupported', 220);
  assert.deepEqual(await unsupported.sample('unsupported', 220), {
    available: false,
    message: 'Resource use is unavailable for this process.'
  });
});

test('keeps a bounded in-memory pulse and clears it when metrics are unavailable', () => {
  const pulse = new RuntimePulseHistory(3);
  for (let index = 0; index < 5; index += 1) {
    pulse.append('project', {
      available: true,
      cpuPercent: index * 10,
      memoryBytes: (index + 1) * 1024
    });
  }

  assert.deepEqual(pulse.get('project'), [
    { cpuPercent: 20, memoryBytes: 3072 },
    { cpuPercent: 30, memoryBytes: 4096 },
    { cpuPercent: 40, memoryBytes: 5120 }
  ]);
  assert.deepEqual(pulse.append('project', { available: false }), []);
  assert.deepEqual(pulse.get('project'), []);
});

test('keeps bounded HTTP response samples and clears unavailable health', () => {
  const pulse = new HttpResponseHistory(3);
  for (let index = 0; index < 5; index += 1) {
    pulse.append('project', 10 + index);
  }

  assert.deepEqual(pulse.get('project'), [
    { responseTimeMs: 12 },
    { responseTimeMs: 13 },
    { responseTimeMs: 14 }
  ]);
  assert.deepEqual(pulse.append('project', undefined), []);
  assert.deepEqual(pulse.get('project'), []);
});

test('resets HTTP response samples when the expanded service target changes or collapses', () => {
  const pulse = new HttpResponseHistory(3);
  pulse.setTarget('project', 4310, 'http://localhost:4310/');
  pulse.record('running', [{
    port: 4310,
    url: 'http://localhost:4310/',
    responseTimeMs: 42
  }]);
  assert.deepEqual(pulse.get('project'), [{ responseTimeMs: 42 }]);

  pulse.setTarget('project', 4310, 'http://localhost:4310/admin');
  assert.deepEqual(pulse.get('project'), []);
  assert.deepEqual(pulse.currentTarget(), {
    projectId: 'project',
    port: 4310,
    url: 'http://localhost:4310/admin'
  });

  pulse.setTarget(undefined, undefined, undefined);
  assert.equal(pulse.currentTarget(), undefined);
  assert.deepEqual(pulse.get('project'), []);
});

test('clears HTTP response samples when health is unavailable', () => {
  for (const [status, responses] of [
    ['stopped', [{ port: 4310, url: 'http://localhost:4310/', responseTimeMs: 20 }]],
    ['not-ready', [{ port: 4310, url: 'http://localhost:4310/', responseTimeMs: 20 }]],
    ['running', []]
  ]) {
    const pulse = new HttpResponseHistory(3);
    pulse.setTarget('project', 4310, 'http://localhost:4310/');
    pulse.record('running', [{
      port: 4310,
      url: 'http://localhost:4310/',
      responseTimeMs: 18
    }]);
    assert.deepEqual(pulse.record(status, responses), []);
    assert.deepEqual(pulse.get('project'), []);
  }
});

test('uses exact POSIX process-group queries for a fully valid requested batch', async () => {
  const calls = [];
  const rows = await readOwnedProcessTree(41, 'darwin', {
    runFile: async (command, args) => {
      calls.push([command, args]);
      if (command === 'pgrep') {
        return '41\n42\n';
      }
      return [
        ' 41 1 41 41 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node server.js',
        ' 42 41 41 41 501 Sun Aug 16 12:00:01 2026 00:00.50 2048 /bin/zsh -c worker'
      ].join('\n');
    }
  });

  assert.deepEqual(calls[0], ['pgrep', ['-g', '41']]);
  assert.deepEqual(calls[1][1].at(-1), '41,42');
  assert.deepEqual(calls[1][1].slice(-4, -2), ['-o', 'command=']);
  assert.deepEqual(rows.map((item) => item.pid), [41, 42]);
  assert.equal(parseCpuTime('1-02:03:04.5'), 93784.5);
});

test('uses one stable versioned macOS identity across metrics captures', async () => {
  let details = {
    uid: 501,
    processGroupId: 55,
    sessionId: 55,
    command: '/Applications/Node/bin/node server.js --port 3000'
  };
  const calls = [];
  const read = () => readRootProcess(55, 'darwin', {
    runFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return ` 55 1 ${details.processGroupId} ${details.sessionId} ${details.uid} Sun Aug 16 12:00:00 2026 00:01.00 1024 ${details.command}`;
    }
  });
  const expected = expectedDarwinIdentity(55, '2026-08-16T12:00:00', details);

  assert.equal((await read()).identity, expected);
  assert.equal((await read()).identity, expected);
  details = { ...details, command: '/Applications/Node/bin/node server.js --port 4000' };
  assert.notEqual((await read()).identity, expected);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.file, 'ps');
    assert.deepEqual(call.args, [
      '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'sess=',
      '-o', 'uid=', '-o', 'lstart=', '-o', 'time=', '-o', 'rss=',
      '-o', 'command=', '-p', '55'
    ]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.LC_ALL, 'C');
    assert.equal(call.options.env.LANG, 'C');
    assert.equal(call.options.env.TZ, 'UTC');
  }

  for (const output of [
    ' 55 1 55 55 501 Lun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node',
    ' 55 1 55 55 nope Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node',
    ' 55 1 55 55 501 Sun Aug 16 12:00:00 2026 00:01.00 1024',
    ' 55 1 55 55 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node\n 56 1 56 56 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /bin/zsh'
  ]) {
    assert.equal(await readRootProcess(55, 'darwin', {
      runFile: async () => output
    }), undefined);
  }
});

test('accepts uid zero in a stable versioned macOS async identity', async () => {
  const details = {
    uid: 0,
    processGroupId: 55,
    sessionId: '2fd65f0',
    command: '/usr/local/bin/node root.js'
  };
  const read = () => readRootProcess(55, 'darwin', {
    runFile: async () => '55 1 55 2FD65F0 0 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node root.js'
  });

  const first = await read();
  const second = await read();
  assert.equal(first.identity, expectedDarwinIdentity(55, '2026-08-16T12:00:00', details));
  assert.equal(second.identity, first.identity);
  assert.match(first.identity, /^55:darwin:v2:/);
  assert.equal(await readRootProcess(55, 'darwin', {
    runFile: async () => '55 1 55 2fd65f0 -1 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node root.js'
  }), undefined);
});

test('rejects an entire macOS capture when any physical row is invalid or ambiguous', async () => {
  const valid = '55 1 55 303 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node server.js';
  const other = '56 1 56 303 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /bin/zsh';
  for (const output of [
    `${valid}\nforged-trailing-row`,
    `${valid}\n${valid}`,
    `${valid}\n${other}`,
    `${valid}\n--forged-argument-row`
  ]) {
    assert.equal(await readRootProcess(55, 'darwin', {
      runFile: async () => output
    }), undefined);
  }

  const rows = await readOwnedProcessTree(41, 'darwin', {
    runFile: async (command) => command === 'pgrep'
      ? '41\n42\n'
      : [
        '41 1 41 303 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node root.js',
        'forged-trailing-row'
      ].join('\n')
  });
  assert.deepEqual(rows, []);

  const changedGroup = await readOwnedProcessTree(41, 'darwin', {
    runFile: async (command) => command === 'pgrep'
      ? '41\n42\n'
      : [
        '41 1 41 0 501 Sun Aug 16 12:00:00 2026 00:01.00 1024 /usr/local/bin/node root.js',
        '42 41 99 0 501 Sun Aug 16 12:00:01 2026 00:00.50 2048 /bin/zsh -c worker'
      ].join('\n')
  });
  assert.deepEqual(changedGroup, []);
});

test('uses Linux kernel start ticks for process identity', async () => {
  const rows = await readOwnedProcessTree(41, 'linux', {
    runFile: async (command) => command === 'pgrep'
      ? '41\n42\n'
      : [
        ' 41 1 41 Sun Aug 16 12:00:00 2026 00:01.00 1024',
        ' 42 41 41 Sun Aug 16 12:00:01 2026 00:00.50 2048'
      ].join('\n'),
    readLinuxStartTicks: async (pid) => String(987654 + pid)
  });

  assert.deepEqual(rows.map(({ pid, identity }) => ({ pid, identity })), [
    { pid: 41, identity: '41:linux:987695' },
    { pid: 42, identity: '42:linux:987696' }
  ]);
});

test('fails closed when Linux kernel process identity is unavailable', async () => {
  const actual = await readRootProcess(55, 'linux', {
    runFile: async () => ' 55 1 55 Sun Aug 16 12:00:00 2026 00:01.00 1024',
    readLinuxStartTicks: async () => { throw new Error('procfs unavailable'); }
  });

  assert.equal(actual, undefined);
});

test('treats a POSIX root disappearing during inspection as absent', async () => {
  const missing = Object.assign(new Error('process disappeared'), { code: 1 });

  assert.equal(await readRootProcess(55, 'darwin', {
    runFile: async () => { throw missing; }
  }), undefined);
  await assert.rejects(
    readRootProcess(55, 'darwin', {
      runFile: async () => { throw Object.assign(new Error('ps failed'), { code: 2 }); }
    }),
    /ps failed/
  );
});

test('builds a bounded Windows descendant query without a system-wide process request', () => {
  const script = windowsProcessScript(55, true);
  assert.match(script, /ProcessId = /);
  assert.match(script, /ParentProcessId = /);
  assert.match(script, /rows\.Count -lt 64/);
  assert.doesNotMatch(script, /Get-CimInstance Win32_Process;/);
  assert.doesNotMatch(script, /};elseif/);
  assert.match(script, /if\(\$null -eq \$root -and \$includeTree\)/);
  assert.match(script, /Get-Process -Id \$process\.ProcessId/);
  assert.match(script, /'T' \+ \$live\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(\)/);

  assert.deepEqual(parseWindowsProcessOutput(JSON.stringify({
    pid: 55,
    parentPid: 1,
    startedAt: 'T638909280000000000',
    cpuSeconds: 1.25,
    memoryBytes: 4096
  })), [{
    pid: 55,
    parentPid: 1,
    identity: '55:638909280000000000',
    cpuSeconds: 1.25,
    memoryBytes: 4096
  }]);
  assert.deepEqual(parseWindowsProcessOutput(JSON.stringify({
    pid: 55,
    parentPid: 1,
    startedAt: '638909280000000000',
    cpuSeconds: 1.25,
    memoryBytes: 4096
  })), [{
    pid: 55,
    parentPid: 1,
    identity: '55:638909280000000000',
    cpuSeconds: 1.25,
    memoryBytes: 4096
  }]);
  assert.deepEqual(parseWindowsProcessOutput(JSON.stringify({
    pid: 55,
    parentPid: 1,
    startedAt: Number('638912345678901234'),
    cpuSeconds: 1.25,
    memoryBytes: 4096
  })), []);
});

test('preserves full Windows tick precision across prefixed JSON and sync capture', () => {
  const {
    normalizeWindowsStartedAt,
    windowsProcessIdentity,
    windowsStartedAtPowerShellExpression
  } = require('../src/lifecycle/process-metrics');
  const ticks = '638912345678901234';
  assert.equal(normalizeWindowsStartedAt(`T${ticks}`), ticks);
  assert.equal(normalizeWindowsStartedAt(ticks), ticks);
  assert.equal(normalizeWindowsStartedAt(Number(ticks)), undefined);
  assert.equal(windowsProcessIdentity(55, `T${ticks}`), `55:${ticks}`);
  assert.equal(windowsProcessIdentity(55, Number(ticks)), undefined);
  assert.match(
    windowsStartedAtPowerShellExpression('$process'),
    /'T' \+ \$process\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(\)/
  );
});

test('allows the bounded Windows tree query enough time for cold CI process inspection', async () => {
  let commandOptions;
  await readOwnedProcessTree(55, 'win32', {
    runFile: async (_command, _args, options) => {
      commandOptions = options;
      return '[]';
    }
  });

  assert.equal(commandOptions.timeout, 10000);
});

test('renders accessible metrics only inside the expanded preview and stops sampling on collapse', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
  const messageRouter = fs.readFileSync(path.join(root, 'media', 'message-router.js'), 'utf8');

  assert.match(extension, /this\.processOwnership\.owns\(id, child\.pid\)/);
  assert.match(extension, /RESOURCE_SAMPLE_INTERVAL_MS = 5000/);
  assert.match(extension, /this\.syncResourceSampling\(expandedPreview\?\.id\)/);
  assert.match(extension, /const projectId = this\.resourceSampleProjectId;[\s\S]*this\.runtimePulseHistory\.clear\(projectId\)/);
  assert.match(extension, /stopResourceSampling\(\)[\s\S]*clearInterval\(this\.resourceSampleTimer\)/);
  assert.match(webview, /data-resource-metrics[\s\S]*role="group"[\s\S]*aria-label=/);
  assert.match(webview, /project\.previewExpanded \? `[\s\S]*resource-metrics/);
  assert.match(webview, /class="runtime-pulse[\s\S]*aria-hidden="true"[\s\S]*focusable="false"/);
  assert.match(webview, /resourceMetricsContent\([\s\S]*message\.metrics,[\s\S]*message\.runtimePulse,[\s\S]*message\.httpResponsePulse/);
  assert.match(extension, /messageToken: this\.webviewMessageToken/);
  assert.match(messageRouter, /value\.messageToken !== messageToken/);
});

test('reuses health polling for an accessible expanded HTTP response pulse', () => {
  const root = path.join(__dirname, '..');
  const extension = readShippedHostSource(root);
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /this\.httpResponseHistory\.record\([\s\S]*activeCheck\?\.\[6\]/);
  assert.match(extension, /syncHttpResponsePulseTarget\([\s\S]*expandedPreview\?\.previewPort,[\s\S]*expandedPreview\?\.previewUrl/);
  assert.match(extension, /serviceUrls\.map\(\(\{ port, url \}\) => \(\{ port, url \}\)\)/);
  assert.match(webview, /<strong>HTTP<\/strong>[\s\S]*data-http-response/);
  assert.match(webview, /HTTP response time \$\{formatResponseTime\(latest\)\}/);
  assert.match(webview, /projectHttpPulse: \(message\) =>/);
});

test('keeps the CPU and memory explanation when HTTP timing is available', () => {
  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

  assert.match(
    webview,
    /if \(metrics\?\.available\)[\s\S]*else \{\s*const message = unavailableResourceText\(metrics\);[\s\S]*return `\$\{processMetrics\}\$\{httpContent\}`;/
  );
  assert.match(
    webview,
    /if \(metrics\?\.available\)[\s\S]*else \{\s*parts\.push\(unavailableResourceText\(metrics\)\);[\s\S]*HTTP response time/
  );
});
