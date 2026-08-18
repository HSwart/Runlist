const { execFile } = require('child_process');

const MAX_PROCESS_COUNT = 64;
const COMMAND_TIMEOUT_MS = 4000;

class OwnedProcessMetrics {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.now = options.now || Date.now;
    this.readRoot = options.readRoot || ((pid) => readRootProcess(pid, this.platform, options));
    this.readTree = options.readTree || ((pid) => readOwnedProcessTree(pid, this.platform, options));
    this.tracked = new Map();
  }

  track(projectId, pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }
    const record = {
      pid,
      identity: Promise.resolve(this.readRoot(pid))
        .then((row) => row?.identity)
        .catch(() => undefined),
      previous: undefined
    };
    this.tracked.set(projectId, record);
  }

  untrack(projectId) {
    this.tracked.delete(projectId);
  }

  async sample(projectId, pid) {
    const record = this.tracked.get(projectId);
    if (!record || record.pid !== pid) {
      return unavailableMetrics('Resource use is unavailable because process ownership is uncertain.');
    }

    const expectedIdentity = await record.identity;
    if (!expectedIdentity || this.tracked.get(projectId) !== record) {
      return unavailableMetrics('Resource use is unavailable for this process.');
    }

    try {
      const rows = await this.readTree(pid);
      const root = rows.find((row) => row.pid === pid);
      if (!root || root.identity !== expectedIdentity) {
        this.tracked.delete(projectId);
        return unavailableMetrics('Resource use stopped because process ownership changed.');
      }

      const timestamp = this.now();
      const current = new Map(rows.map((row) => [row.pid, row]));
      const memoryBytes = rows.reduce((total, row) => total + row.memoryBytes, 0);
      let cpuPercent;
      if (record.previous && timestamp > record.previous.timestamp) {
        let cpuSeconds = 0;
        for (const row of rows) {
          const previous = record.previous.rows.get(row.pid);
          if (previous?.identity === row.identity && row.cpuSeconds >= previous.cpuSeconds) {
            cpuSeconds += row.cpuSeconds - previous.cpuSeconds;
          }
        }
        cpuPercent = Math.max(0, (cpuSeconds / ((timestamp - record.previous.timestamp) / 1000)) * 100);
      }
      record.previous = { rows: current, timestamp };
      return {
        available: true,
        cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : undefined,
        memoryBytes,
        processCount: rows.length
      };
    } catch {
      record.previous = undefined;
      return unavailableMetrics('Resource use is unavailable on this system.');
    }
  }
}

async function readRootProcess(pid, platform = process.platform, options = {}) {
  const rows = platform === 'win32'
    ? await readWindowsProcesses(pid, false, options)
    : await readPosixProcesses([pid], undefined, options);
  return rows.find((row) => row.pid === pid);
}

async function readOwnedProcessTree(pid, platform = process.platform, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return [];
  }
  if (platform === 'win32') {
    return readWindowsProcesses(pid, true, options);
  }

  const runFile = options.runFile || execFileText;
  let output;
  try {
    output = await runFile('pgrep', ['-g', String(pid)], commandOptions(options));
  } catch (error) {
    if (error.code === 1) {
      return [];
    }
    throw error;
  }
  const pids = [...new Set(String(output).split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (!pids.length || pids.length > MAX_PROCESS_COUNT) {
    return [];
  }
  return readPosixProcesses(pids, pid, options);
}

async function readPosixProcesses(pids, processGroupId, options = {}) {
  const runFile = options.runFile || execFileText;
  const output = await runFile('ps', [
    '-o', 'pid=',
    '-o', 'ppid=',
    '-o', 'pgid=',
    '-o', 'lstart=',
    '-o', 'time=',
    '-o', 'rss=',
    '-p', pids.join(',')
  ], commandOptions(options));
  return String(output).split(/\r?\n/)
    .map(parsePosixProcess)
    .filter((row) => row
      && (processGroupId === undefined || row.processGroupId === processGroupId));
}

function parsePosixProcess(line) {
  const match = String(line).match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(\d+)\s*$/);
  if (!match) {
    return undefined;
  }
  const startedAt = Date.parse(match[4].trim());
  const cpuSeconds = parseCpuTime(match[5]);
  const memoryKilobytes = Number(match[6]);
  if (!Number.isFinite(startedAt) || !Number.isFinite(cpuSeconds) || !Number.isFinite(memoryKilobytes)) {
    return undefined;
  }
  const pid = Number(match[1]);
  return {
    pid,
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    identity: `${pid}:${startedAt}`,
    cpuSeconds,
    memoryBytes: memoryKilobytes * 1024
  };
}

function parseCpuTime(value) {
  const [dayPart, clockPart] = String(value).includes('-')
    ? String(value).split('-', 2)
    : ['0', String(value)];
  const parts = clockPart.split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) {
    return Number.NaN;
  }
  if (parts.length > 3) {
    return Number.NaN;
  }
  const padded = Array(3 - parts.length).fill(0).concat(parts);
  return (Number(dayPart) * 86400) + (padded[0] * 3600) + (padded[1] * 60) + padded[2];
}

async function readWindowsProcesses(pid, includeTree, options = {}) {
  const runFile = options.runFile || execFileText;
  const script = windowsProcessScript(pid, includeTree);
  const output = await runFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
  ], commandOptions(options));
  if (!String(output).trim()) {
    return [];
  }
  return parseWindowsProcessOutput(output);
}

function parseWindowsProcessOutput(output) {
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.pid),
    parentPid: Number(row.parentPid),
    identity: `${Number(row.pid)}:${String(row.startedAt)}`,
    cpuSeconds: Number(row.cpuSeconds),
    memoryBytes: Number(row.memoryBytes)
  })).filter(validMetricRow);
}

function windowsProcessScript(pid, includeTree) {
  return [
    "$ErrorActionPreference='Stop'",
    `$rootPid=${pid}`,
    '$queue=New-Object System.Collections.Queue',
    '$queue.Enqueue([pscustomobject]@{id=$rootPid;parent=$null})',
    '$rows=@()',
    `$includeTree=$${includeTree ? 'true' : 'false'}`,
    `while($queue.Count -gt 0 -and $rows.Count -lt ${MAX_PROCESS_COUNT}){`,
    '  $item=$queue.Dequeue()',
    '  $process=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$item.id)',
    '  if($null -eq $process){continue}',
    '  if($null -ne $item.parent -and [int]$process.ParentProcessId -ne [int]$item.parent){continue}',
    '  $rows += [pscustomobject]@{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;startedAt=$process.CreationDate.ToUniversalTime().Ticks.ToString();cpuSeconds=([double]$process.KernelModeTime+[double]$process.UserModeTime)/10000000;memoryBytes=[double]$process.WorkingSetSize}',
    '  if($includeTree){',
    '    $children=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + [int]$process.ProcessId))',
    '    foreach($child in $children){$queue.Enqueue([pscustomobject]@{id=[int]$child.ProcessId;parent=[int]$process.ProcessId})}',
    '  }',
    '}',
    `if($queue.Count -gt 0){throw 'Runlist process tree exceeds ${MAX_PROCESS_COUNT} processes.'}`,
    '@($rows) | ConvertTo-Json -Compress'
  ].join(';');
}

function validMetricRow(row) {
  return Number.isInteger(row.pid)
    && row.pid > 0
    && typeof row.identity === 'string'
    && Number.isFinite(row.cpuSeconds)
    && row.cpuSeconds >= 0
    && Number.isFinite(row.memoryBytes)
    && row.memoryBytes >= 0;
}

function commandOptions(options) {
  return {
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: options.maxBuffer || 256 * 1024,
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
    windowsHide: true
  };
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function unavailableMetrics(message) {
  return { available: false, message };
}

module.exports = {
  OwnedProcessMetrics,
  parseCpuTime,
  parsePosixProcess,
  parseWindowsProcessOutput,
  readRootProcess,
  readOwnedProcessTree,
  windowsProcessScript
};
