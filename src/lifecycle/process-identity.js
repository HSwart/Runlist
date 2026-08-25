const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  darwinProcessIdentityFormat,
  normalizeWindowsStartedAt,
  parseDarwinProcessIdentity,
  readRootProcess,
  windowsProcessIdentity,
  windowsStartedAtPowerShellExpression
} = require('./process-metrics');

const DARWIN_IDENTITY_PS_ARGS = [
  '-ww', '-p', undefined,
  '-o', 'lstart=',
  '-o', 'uid=',
  '-o', 'pgid=',
  '-o', 'sess=',
  '-o', 'command='
];
const RUNTIME_PROCESS_STARTED_AT = Math.round(Date.now() - (process.uptime() * 1000));
const CURRENT_PROCESS_IDENTITIES = new Map();

function stableProcessIdentity(identity) {
  return typeof identity === 'string'
    && identity.length > 0
    && identity.trim() === identity;
}

function processIdentityDecision(expectedIdentity, currentIdentity, platform, pid, options = {}) {
  if (!stableProcessIdentity(expectedIdentity) || !stableProcessIdentity(currentIdentity)) {
    return 'unavailable';
  }
  const expectedRuntime = runtimeProcessIdentity(expectedIdentity, pid);
  const currentRuntime = runtimeProcessIdentity(currentIdentity, pid);
  if (expectedRuntime || currentRuntime) {
    if (!options.allowRuntime || !expectedRuntime || !currentRuntime) {
      return 'unavailable';
    }
    return expectedIdentity === currentIdentity ? 'match' : 'mismatch';
  }
  if (platform === 'darwin') {
    if (darwinProcessIdentityFormat(expectedIdentity, pid) !== 'v2'
      || darwinProcessIdentityFormat(currentIdentity, pid) !== 'v2') {
      return 'unavailable';
    }
    return expectedIdentity === currentIdentity ? 'match' : 'mismatch';
  }
  if (platform === 'linux') {
    const expectedTicks = linuxProcessStartTicks(expectedIdentity, pid);
    const currentTicks = linuxProcessStartTicks(currentIdentity, pid);
    if (expectedTicks !== undefined || currentTicks !== undefined) {
      if (expectedTicks === undefined || currentTicks === undefined) {
        return 'unavailable';
      }
      return expectedTicks === currentTicks ? 'match' : 'mismatch';
    }
  }
  return expectedIdentity === currentIdentity ? 'match' : 'mismatch';
}

function processIdentityMismatch(expectedIdentity, currentIdentity, platform, pid, options) {
  return processIdentityDecision(
    expectedIdentity,
    currentIdentity,
    platform,
    pid,
    options
  ) === 'mismatch';
}

function linuxProcessStartTicks(identity, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const match = String(identity).match(new RegExp(`^${pid}:(?:linux:)?(\\d+)$`));
  return match && BigInt(match[1]) > 0n ? match[1] : undefined;
}

function runtimeProcessIdentity(identity, pid) {
  return Number.isInteger(pid)
    && pid > 0
    && new RegExp(`^${pid}:runtime:\\d+$`).test(String(identity));
}

async function readProcessIdentity(pid, platform = process.platform, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    return (await readRootProcess(pid, platform, options))?.identity;
  } catch {
    return undefined;
  }
}

function readProcessIdentitySync(pid, platform = process.platform, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const readFile = options.readFileSync || fs.readFileSync;
  const runFile = options.execFileSync || execFileSync;
  try {
    if (platform === 'linux') {
      const stat = String(readFile(`/proc/${pid}/stat`, 'utf8'));
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open <= 0
        || close <= open
        || stat.slice(0, open).trim() !== String(pid)) {
        return undefined;
      }
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!/^\d+$/.test(startTicks || '') || BigInt(startTicks) <= 0n) {
        return undefined;
      }
      return `${pid}:linux:${startTicks}`;
    }
    if (platform === 'win32') {
      const startedAt = String(runFile('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        windowsStartedAtPowerShellExpression(`(Get-Process -Id ${pid} -ErrorAction Stop)`)
      ], { encoding: 'utf8', windowsHide: true, timeout: 1000 })).trim();
      return windowsProcessIdentity(pid, startedAt);
    }
    if (platform === 'darwin') {
      return parseDarwinProcessIdentity(
        pid,
        runFile('ps', darwinIdentityPsArgs(pid), darwinIdentityCommandOptions())
      );
    }
    const startedAt = String(runFile('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 1000,
      windowsHide: true
    })).trim();
    return startedAt ? `${pid}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

function currentProcessIdentity(options = {}) {
  const pid = options.pid ?? process.pid;
  const platform = options.platform || process.platform;
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const cacheKey = pid === process.pid
    && options.now === undefined
    && options.uptime === undefined
    ? platform
    : undefined;
  if (cacheKey && CURRENT_PROCESS_IDENTITIES.has(cacheKey)) {
    return CURRENT_PROCESS_IDENTITIES.get(cacheKey);
  }
  const identity = readProcessIdentitySync(pid, platform, options);
  if (stableProcessIdentity(identity)) {
    if (cacheKey) {
      CURRENT_PROCESS_IDENTITIES.set(cacheKey, identity);
    }
    return identity;
  }
  if (!options.allowRuntimeFallback) {
    return undefined;
  }
  const runtimeStartedAt = options.now || options.uptime
    ? Math.round((options.now || Date.now)() - ((options.uptime || process.uptime)() * 1000))
    : RUNTIME_PROCESS_STARTED_AT;
  const fallbackIdentity = `${pid}:runtime:${runtimeStartedAt}`;
  if (cacheKey) {
    CURRENT_PROCESS_IDENTITIES.set(cacheKey, fallbackIdentity);
  }
  return fallbackIdentity;
}

function darwinIdentityPsArgs(pid) {
  const args = [...DARWIN_IDENTITY_PS_ARGS];
  args[2] = String(pid);
  return args;
}

function darwinIdentityCommandOptions() {
  return {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 1000,
    windowsHide: true
  };
}

module.exports = {
  currentProcessIdentity,
  darwinProcessIdentityFormat,
  normalizeWindowsStartedAt,
  processIdentityDecision,
  processIdentityMismatch,
  readProcessIdentity,
  readProcessIdentitySync,
  stableProcessIdentity,
  windowsProcessIdentity
};
