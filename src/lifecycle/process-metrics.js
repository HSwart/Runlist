const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const MAX_PROCESS_COUNT = 64;
const COMMAND_TIMEOUT_MS = 4000;
const ROOT_PROCESS_COMMAND_TIMEOUT_MS = 10000;
const DARWIN_MONTHS = new Map([
  ['Jan', 1], ['Feb', 2], ['Mar', 3], ['Apr', 4], ['May', 5], ['Jun', 6],
  ['Jul', 7], ['Aug', 8], ['Sep', 9], ['Oct', 10], ['Nov', 11], ['Dec', 12]
]);
const DARWIN_WEEKDAYS = new Map([
  ['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3],
  ['Thu', 4], ['Fri', 5], ['Sat', 6]
]);

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
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (platform === 'win32') {
    return readWindowsRootProcess(pid, options);
  }

  const rows = await readPosixProcesses([pid], undefined, options, platform);
  if (platform === 'darwin' && rows.length !== 1) {
    return undefined;
  }
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
    output = await runFile('pgrep', ['-g', String(pid)], commandOptions(options, platform));
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
  return readPosixProcesses(pids, pid, options, platform);
}

async function readPosixProcesses(pids, processGroupId, options = {}, platform = process.platform) {
  const runFile = options.runFile || execFileText;
  const args = [
    ...(platform === 'darwin' ? ['-ww'] : []),
    '-o', 'pid=',
    '-o', 'ppid=',
    '-o', 'pgid=',
    ...(platform === 'darwin' ? ['-o', 'sess=', '-o', 'uid='] : []),
    '-o', 'lstart=',
    '-o', 'time=',
    '-o', 'rss='
  ];
  if (platform === 'darwin') {
    args.push('-o', 'command=');
  }
  args.push('-p', pids.join(','));
  const output = await runFile('ps', args, commandOptions(options, platform));
  const physicalRows = String(output).split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  let rows;
  if (platform === 'darwin') {
    const requestedPids = new Set(pids);
    rows = physicalRows.map((line) => parsePosixProcess(line, platform));
    const returnedPids = new Set();
    let invalid = requestedPids.size !== pids.length;
    for (const row of rows) {
      if (!row
        || !requestedPids.has(row.pid)
        || returnedPids.has(row.pid)
        || (processGroupId !== undefined && row.processGroupId !== processGroupId)) {
        invalid = true;
        break;
      }
      returnedPids.add(row.pid);
    }
    if (invalid) {
      return [];
    }
  } else {
    rows = physicalRows
      .map((line) => parsePosixProcess(line, platform))
      .filter((row) => row
        && (processGroupId === undefined || row.processGroupId === processGroupId));
  }
  if (platform !== 'linux') {
    return rows;
  }

  const readStartTicks = options.readLinuxStartTicks || readLinuxStartTicks;
  const withKernelIdentity = await Promise.all(rows.map(async (row) => {
    try {
      const startTicks = await readStartTicks(row.pid);
      return /^\d+$/.test(String(startTicks))
        ? { ...row, identity: `${row.pid}:linux:${startTicks}` }
        : undefined;
    } catch {
      return undefined;
    }
  }));
  return withKernelIdentity.filter(Boolean);
}

async function readLinuxStartTicks(pid) {
  const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) {
    return undefined;
  }
  // Fields after the command name start at field 3; starttime is field 22.
  return stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
}

function parseDarwinProcessIdentity(pid, output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    return undefined;
  }
  const match = lines[0].match(
    /^((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s+(.+)$/
  );
  return match ? darwinProcessIdentity(pid, match[1], {
    uid: Number(match[2]),
    processGroupId: Number(match[3]),
    sessionId: match[4],
    command: match[5]
  }) : undefined;
}

function darwinProcessIdentity(pid, startedAtText, details = {}) {
  const match = String(startedAtText || '').trim().match(
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/
  );
  if (!Number.isInteger(pid) || pid <= 0 || !match) {
    return undefined;
  }
  const [, weekdayName, monthName, dayText, hourText, minuteText, secondText, yearText] = match;
  const year = Number(yearText);
  const month = DARWIN_MONTHS.get(monthName);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const uid = Number(details.uid);
  const processGroupId = Number(details.processGroupId);
  const sessionId = String(details.sessionId || '').toLowerCase();
  const command = String(details.command || '').trim();
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1970
    || year > 9999
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCDay() !== DARWIN_WEEKDAYS.get(weekdayName)
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(processGroupId)
    || processGroupId <= 0
    || !/^[0-9a-f]+$/.test(sessionId)
    || !command
    || /[\u0000-\u001f\u007f]/.test(command)) {
    return undefined;
  }
  const startedAt = `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    + `T${hourText}:${minuteText}:${secondText}`;
  const canonical = [
    'runlist-darwin-process',
    'v2',
    String(pid),
    startedAt,
    String(uid),
    String(processGroupId),
    String(sessionId),
    command
  ].map(lengthDelimitedIdentityValue).join('');
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
  return `${pid}:darwin:v2:${startedAt}:${fingerprint}`;
}

function lengthDelimitedIdentityValue(value) {
  const text = String(value);
  return `${Buffer.byteLength(text, 'utf8')}:${text}`;
}

function darwinProcessIdentityFormat(identity, pid) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof identity !== 'string') {
    return 'invalid';
  }
  const prefix = `${pid}:`;
  if (new RegExp(`^${pid}:darwin:v2:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}:[a-f0-9]{64}$`).test(identity)) {
    return 'v2';
  }
  if (new RegExp(`^${pid}:darwin:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}:[a-f0-9]{64}$`).test(identity)
    || new RegExp(`^${pid}:\\d+$`).test(identity)
    || (identity.startsWith(prefix)
      && /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(identity.slice(prefix.length)))) {
    return 'legacy';
  }
  return 'invalid';
}

function parsePosixProcess(line, platform = process.platform) {
  const match = String(line).match(platform === 'darwin'
    ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(\d+)\s+(.+?)\s*$/
    : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(\d+)\s*$/);
  if (!match) {
    return undefined;
  }
  const startedAtIndex = platform === 'darwin' ? 6 : 4;
  const cpuIndex = platform === 'darwin' ? 7 : 5;
  const memoryIndex = platform === 'darwin' ? 8 : 6;
  const startedAt = Date.parse(match[startedAtIndex].trim());
  const cpuSeconds = parseCpuTime(match[cpuIndex]);
  const memoryKilobytes = Number(match[memoryIndex]);
  if (!Number.isFinite(startedAt) || !Number.isFinite(cpuSeconds) || !Number.isFinite(memoryKilobytes)) {
    return undefined;
  }
  const pid = Number(match[1]);
  const identity = platform === 'darwin'
    ? darwinProcessIdentity(pid, match[6], {
      uid: Number(match[5]),
      processGroupId: Number(match[3]),
      sessionId: match[4],
      command: match[9]
    })
    : `${pid}:${startedAt}`;
  if (!identity) {
    return undefined;
  }
  return {
    pid,
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    identity,
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

async function readWindowsRootProcess(pid, options = {}) {
  const runFile = options.runFile || execFileText;
  const output = await runFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsRootProcessScript(pid)
  ], commandOptions({
    ...options,
    timeoutMs: options.rootTimeoutMs || ROOT_PROCESS_COMMAND_TIMEOUT_MS
  }));
  if (!String(output).trim()) {
    return undefined;
  }
  return parseWindowsProcessOutput(output).find((row) => row.pid === pid);
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
    '$rows=@()',
    `$includeTree=$${includeTree ? 'true' : 'false'}`,
    '$root=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$rootPid)',
    'if($null -ne $root){$queue.Enqueue([pscustomobject]@{id=$rootPid;parent=$null})}',
    'if($null -eq $root -and $includeTree){',
    '  $rootChildren=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + [int]$rootPid))',
    '  foreach($child in $rootChildren){$queue.Enqueue([pscustomobject]@{id=[int]$child.ProcessId;parent=$rootPid})}',
    '}',
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

function windowsRootProcessScript(pid) {
  return [
    "$ErrorActionPreference='Stop'",
    `$rootPid=${pid}`,
    '$process=Get-Process -Id $rootPid -ErrorAction Stop',
    '$row=[pscustomobject]@{pid=[int]$process.Id;parentPid=0;startedAt=$process.StartTime.ToUniversalTime().Ticks.ToString();cpuSeconds=[double]$process.TotalProcessorTime.TotalSeconds;memoryBytes=[double]$process.WorkingSet64}',
    '$row | ConvertTo-Json -Compress'
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

function commandOptions(options, platform = process.platform) {
  return {
    env: {
      ...process.env,
      ...(platform === 'darwin' ? { LANG: 'C', TZ: 'UTC' } : {}),
      LC_ALL: 'C'
    },
    maxBuffer: options.maxBuffer || 256 * 1024,
    ...(platform === 'darwin' ? { shell: false } : {}),
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
  darwinProcessIdentityFormat,
  darwinProcessIdentity,
  OwnedProcessMetrics,
  parseCpuTime,
  parseDarwinProcessIdentity,
  parsePosixProcess,
  parseWindowsProcessOutput,
  readRootProcess,
  readOwnedProcessTree,
  windowsProcessScript
};
