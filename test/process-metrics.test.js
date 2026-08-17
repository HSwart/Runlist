const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  OwnedProcessMetrics,
  parseCpuTime,
  parseWindowsProcessOutput,
  readOwnedProcessTree,
  windowsProcessScript
} = require('../process-metrics');
const { HttpResponseHistory, RuntimePulseHistory } = require('../runtime-pulse');

function row(pid, identity, cpuSeconds, memoryBytes) {
  return { pid, identity, cpuSeconds, memoryBytes };
}

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

test('uses exact POSIX process-group queries and ignores rows outside that group', async () => {
  const calls = [];
  const rows = await readOwnedProcessTree(41, 'darwin', {
    runFile: async (command, args) => {
      calls.push([command, args]);
      if (command === 'pgrep') {
        return '41\n42\n';
      }
      return [
        ' 41 1 41 Sun Aug 16 12:00:00 2026 00:01.00 1024',
        ' 42 41 41 Sun Aug 16 12:00:01 2026 00:00.50 2048',
        ' 99 1 99 Sun Aug 16 12:00:02 2026 00:30.00 9999'
      ].join('\n');
    }
  });

  assert.deepEqual(calls[0], ['pgrep', ['-g', '41']]);
  assert.deepEqual(calls[1][1].at(-1), '41,42');
  assert.deepEqual(rows.map((item) => item.pid), [41, 42]);
  assert.equal(parseCpuTime('1-02:03:04.5'), 93784.5);
});

test('builds a bounded Windows descendant query without a system-wide process request', () => {
  const script = windowsProcessScript(55, true);
  assert.match(script, /ProcessId = /);
  assert.match(script, /ParentProcessId = /);
  assert.match(script, /rows\.Count -lt 64/);
  assert.doesNotMatch(script, /Get-CimInstance Win32_Process;/);

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
});

test('renders accessible metrics only inside the expanded preview and stops sampling on collapse', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /this\.processOwnership\.owns\(id, child\.pid\)/);
  assert.match(extension, /RESOURCE_SAMPLE_INTERVAL_MS = 5000/);
  assert.match(extension, /this\.syncResourceSampling\(expandedPreview\?\.id\)/);
  assert.match(extension, /const projectId = this\.resourceSampleProjectId;[\s\S]*this\.runtimePulseHistory\.clear\(projectId\)/);
  assert.match(extension, /stopResourceSampling\(\)[\s\S]*clearInterval\(this\.resourceSampleTimer\)/);
  assert.match(webview, /data-resource-metrics[\s\S]*role="group"[\s\S]*aria-label=/);
  assert.match(webview, /project\.previewExpanded \? `[\s\S]*resource-metrics/);
  assert.match(webview, /class="runtime-pulse[\s\S]*aria-hidden="true"[\s\S]*focusable="false"/);
  assert.match(webview, /resourceMetricsContent\([\s\S]*event\.data\.metrics,[\s\S]*event\.data\.runtimePulse,[\s\S]*event\.data\.httpResponsePulse/);
  assert.match(extension, /messageToken: this\.webviewMessageToken/);
  assert.match(webview, /event\.data\?\.messageToken !== state\.messageToken/);
});

test('reuses health polling for an accessible expanded HTTP response pulse', () => {
  const root = path.join(__dirname, '..');
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

  assert.match(extension, /this\.httpResponseHistory\.record\([\s\S]*activeCheck\?\.\[6\]/);
  assert.match(extension, /syncHttpResponsePulseTarget\([\s\S]*expandedPreview\?\.previewPort,[\s\S]*expandedPreview\?\.previewUrl/);
  assert.match(extension, /serviceUrls\.map\(\(\{ port, url \}\) => \(\{ port, url \}\)\)/);
  assert.match(webview, /<strong>HTTP<\/strong>[\s\S]*data-http-response/);
  assert.match(webview, /HTTP response time \$\{formatResponseTime\(latest\)\}/);
  assert.match(webview, /event\.data\?\.type === 'projectHttpPulse'/);
});
