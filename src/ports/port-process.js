const { execFile } = require('child_process');
const {
  processIdentityDecision,
  readProcessIdentity,
  windowsProcessIdentity
} = require('../lifecycle/process-identity');
const { terminateProcessTree } = require('../lifecycle/project-process');
const { windowsStartedAtPowerShellExpression } = require('../lifecycle/process-metrics');

const COMMAND_TIMEOUT_MS = 10000;
const TERMINATION_GRACE_MS = 3000;

async function findListeningProcesses(ports, options = {}) {
  const requestedPorts = [...portSet(ports)].sort((left, right) => left - right);
  if (!requestedPorts.length) {
    return [];
  }
  const platform = options.platform || process.platform;
  const runFile = options.runFile || execFileText;
  if (platform === 'win32') {
    const output = await runFile('netstat.exe', ['-ano', '-p', 'tcp'], commandOptions(options));
    const listeners = parseWindowsNetstatListeners(output, requestedPorts);
    if (!listeners.length) {
      return [];
    }
    let details = new Map();
    try {
      const processOutput = await runFile('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        windowsProcessDetailsScript(listeners.map((listener) => listener.pid))
      ], commandOptions(options));
      details = parseWindowsProcessDetails(processOutput);
    } catch {
      // Return the exact port/PID mapping; recovery will refuse targets without identity.
    }
    return listeners.map((listener) => {
      const detail = details.get(listener.pid);
      return detail ? { ...listener, ...detail } : listener;
    });
  }

  let listeners = [];
  try {
    const output = await runFile('lsof', [
      '-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpcn'
    ], commandOptions(options));
    listeners = parseLsofListeners(output, requestedPorts);
  } catch {
    // Linux installations do not always include lsof; ss is the native fallback.
  }
  if (!listeners.length && platform === 'linux') {
    try {
      const output = await runFile('ss', ['-H', '-ltnp'], commandOptions(options));
      listeners = parseSsListeners(output, requestedPorts);
    } catch {
      listeners = [];
    }
  }
  if (!listeners.length && platform === 'darwin') {
    try {
      const output = await runFile('netstat', ['-anv', '-p', 'tcp'], commandOptions(options));
      listeners = parseDarwinNetstatListeners(output, requestedPorts);
    } catch {
      listeners = [];
    }
  }

  const readIdentity = options.readProcessIdentity
    || ((pid) => readProcessIdentity(pid, platform, options));
  const identities = new Map();
  return Promise.all(listeners.map(async (listener) => {
    if (!identities.has(listener.pid)) {
      identities.set(listener.pid, Promise.resolve(readIdentity(listener.pid, platform))
        .catch(() => undefined));
    }
    const identity = await identities.get(listener.pid);
    return identity ? { ...listener, identity } : listener;
  }));
}

async function terminateListenerProcess(listener, options = {}) {
  const pid = Number(listener?.pid);
  const expectedIdentity = listener?.identity;
  if (!validPid(pid) || typeof expectedIdentity !== 'string') {
    throw new Error('Runlist could not verify the listener process identity.');
  }
  const platform = options.platform || process.platform;
  if (pid === process.pid || (platform === 'win32' ? pid === 4 : pid === 1)) {
    throw new Error('Runlist will not terminate a protected host process.');
  }
  const readIdentity = options.readProcessIdentity
    || ((processId) => readProcessIdentity(processId, platform, options));
  const currentIdentity = await readIdentity(pid, platform);
  if (!currentIdentity && options.allowMissing) {
    return;
  }
  if (processIdentityDecision(expectedIdentity, currentIdentity, platform, pid) !== 'match') {
    throw new Error('Runlist did not close the process because its identity changed.');
  }

  if (platform === 'win32' || options.terminateTree) {
    const terminate = options.terminateProcessTree || terminateProcessTree;
    await terminate(pid, {
      platform,
      ...options.terminationOptions,
      expectedIdentity,
      readProcessIdentity: readIdentity
    });
    return;
  }

  const kill = options.kill || process.kill;
  const isAlive = options.isProcessAlive || processIsAlive;
  const delay = options.delay || ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      return;
    }
    throw error;
  }
  const deadline = Date.now() + (options.graceMs ?? TERMINATION_GRACE_MS);
  while (isAlive(pid) && Date.now() < deadline) {
    await delay(50);
  }
  if (!isAlive(pid)) {
    return;
  }
  const escalatedIdentity = await readIdentity(pid, platform);
  if (!escalatedIdentity) {
    return;
  }
  if (processIdentityDecision(expectedIdentity, escalatedIdentity, platform, pid) !== 'match') {
    throw new Error('Runlist did not force close the process because its identity changed.');
  }
  try {
    kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function parseWindowsNetstatListeners(output, ports) {
  const allowed = portSet(ports);
  const listeners = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) {
      continue;
    }
    const port = endpointPort(match[1]);
    const pid = Number(match[2]);
    if (allowed.has(port) && validPid(pid)) {
      listeners.push({ port, pid, name: 'Unknown process' });
    }
  }
  return deduplicateListeners(listeners);
}

function parseLsofListeners(output, ports) {
  const allowed = portSet(ports);
  const listeners = [];
  let pid;
  let name = 'Unknown process';
  for (const line of String(output).split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      pid = Number(value);
      name = 'Unknown process';
    } else if (field === 'c') {
      name = processName(value);
    } else if (field === 'n' && validPid(pid)) {
      const port = endpointPort(value);
      if (allowed.has(port)) {
        listeners.push({ port, pid, name });
      }
    }
  }
  return deduplicateListeners(listeners);
}

function parseSsListeners(output, ports) {
  const allowed = portSet(ports);
  const listeners = [];
  for (const line of String(output).split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const port = endpointPort(columns[3]);
    if (!allowed.has(port)) {
      continue;
    }
    const ownerPattern = /"([^"]+)",pid=(\d+)/g;
    let match;
    while ((match = ownerPattern.exec(line)) !== null) {
      const pid = Number(match[2]);
      if (validPid(pid)) {
        listeners.push({ port, pid, name: processName(match[1]) });
      }
    }
  }
  return deduplicateListeners(listeners);
}

function parseDarwinNetstatListeners(output, ports) {
  const allowed = portSet(ports);
  const listeners = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (!/\sLISTEN\b/.test(line)) {
      continue;
    }
    const columns = line.trim().split(/\s+/);
    const localEndpoint = columns[3] || columns[2];
    const port = endpointPort(localEndpoint);
    const pid = Number(columns[columns.length - 2]);
    if (!allowed.has(port) || !validPid(pid)) {
      continue;
    }
    listeners.push({ port, pid, name: 'Unknown process' });
  }
  return deduplicateListeners(listeners);
}

function portSet(ports) {
  return new Set((ports || [])
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535));
}

function endpointPort(value) {
  const text = String(value || '');
  const colonMatch = text.match(/:(\d+)$/);
  if (colonMatch) {
    return Number(colonMatch[1]);
  }
  const dotMatch = text.match(/\.(\d+)$/);
  return dotMatch ? Number(dotMatch[1]) : undefined;
}

function processName(value) {
  const name = String(value || '').trim();
  return name || 'Unknown process';
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function deduplicateListeners(listeners) {
  const seen = new Set();
  return listeners.filter((listener) => {
    const key = `${listener.port}:${listener.pid}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((left, right) => left.port - right.port || left.pid - right.pid);
}

function windowsProcessDetailsScript(pids) {
  const processIds = [...new Set(pids.filter(validPid))];
  return [
    "$ErrorActionPreference='Stop'",
    `$requestedProcessIds=@(${processIds.join(',')})`,
    '$rows=@()',
    'foreach($ownerProcessId in $requestedProcessIds){',
    '  $ownerProcess=Get-Process -Id ([int]$ownerProcessId) -ErrorAction SilentlyContinue',
    '  if($null -eq $ownerProcess){continue}',
    '  try {',
    `    $startedAt=${windowsStartedAtPowerShellExpression('$ownerProcess')}`,
    '    $rows += [pscustomobject]@{pid=[int]$ownerProcess.Id;name=[string]$ownerProcess.ProcessName;startedAt=$startedAt}',
    '  } catch { continue }',
    '}',
    '@($rows) | ConvertTo-Json -Compress'
  ].join(';');
}

function parseWindowsProcessDetails(output) {
  if (!String(output).trim()) {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return new Map();
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(rows.map((row) => {
    const pid = Number(row?.pid);
    const identity = windowsProcessIdentity(pid, row?.startedAt);
    return validPid(pid) && identity
      ? [pid, { name: processName(row?.name), identity }]
      : undefined;
  }).filter(Boolean));
}

function commandOptions(options) {
  return {
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 256 * 1024,
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
    windowsHide: true
  };
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

module.exports = {
  findListeningProcesses,
  parseDarwinNetstatListeners,
  parseLsofListeners,
  parseSsListeners,
  parseWindowsNetstatListeners,
  terminateListenerProcess,
  windowsProcessDetailsScript
};
