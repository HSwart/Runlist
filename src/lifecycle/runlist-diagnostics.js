const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { redactSensitiveText } = require('../projects/project-diagnostics');

const MAX_EVENTS = 200;
const MAX_PROJECTS = 1000;
const MAX_DETAIL_CHARS = 500;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

class RunlistDiagnostics {
  constructor(options = {}) {
    this.outputChannel = options.outputChannel;
    this.traceEnabled = options.traceEnabled || (() => false);
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.projectSalt = options.projectSalt || this.randomUUID();
    this.environment = normalizeEnvironment(options.environment);
    this.events = [];
    this.operationContext = new AsyncLocalStorage();
    this.record('session.started');
  }

  async run(kind, projectId, operation, snapshot) {
    const safeKind = safeLabel(kind, 'operation');
    const parent = this.operationContext.getStore();
    const operationId = parent?.operationId || this.randomUUID();
    const execute = async () => {
      const previous = safeSnapshot(snapshot);
      this.record(`${safeKind}.begin`, { projectId, ...previous });
      try {
        const result = await operation();
        const resulting = safeSnapshot(snapshot);
        this.record(`${safeKind}.complete`, {
          projectId,
          outcome: result === false ? 'rejected' : 'completed',
          ...resulting,
          previousStatus: previous.status,
          resultingStatus: resulting.status,
          reasonCode: result === false ? 'operation-rejected' : 'operation-completed'
        });
        return result;
      } catch (error) {
        const resulting = safeSnapshot(snapshot);
        this.record(`${safeKind}.failed`, {
          projectId,
          outcome: 'failed',
          error,
          ...resulting,
          previousStatus: previous.status,
          resultingStatus: resulting.status,
          reasonCode: 'operation-failed'
        });
        throw error;
      }
    };
    return this.operationContext.run({ operationId }, execute);
  }

  record(event, details = {}) {
    try {
      const entry = {
        at: new Date(this.now()).toISOString(),
        event: safeLabel(event, 'event'),
        operationId: safeOperationId(
          details.operationId || this.operationContext.getStore()?.operationId
        )
      };
      if (details.projectId !== undefined) {
        entry.projectRef = this.projectRef(details.projectId);
      }
      copySafeDetails(entry, details, this.traceEnabled());
      this.events.push(entry);
      if (this.events.length > MAX_EVENTS) {
        this.events.splice(0, this.events.length - MAX_EVENTS);
      }
      this.outputChannel?.appendLine(JSON.stringify(entry));
      return entry;
    } catch {
      return undefined;
    }
  }

  supportReport(snapshot = {}) {
    const projects = Array.isArray(snapshot.projects)
      ? snapshot.projects.slice(0, MAX_PROJECTS).map((project) => ({
          projectRef: this.projectRef(project?.id),
          status: safeLabel(project?.status, 'unknown'),
          serviceCount: safeCount(project?.serviceCount),
          ownershipPresent: project?.ownershipPresent === true,
          reservationPresent: project?.reservationPresent === true,
          localProcess: project?.localProcess === true,
          ...(project?.processState
            ? { processState: safeLabel(project.processState, 'unknown') }
            : {}),
          ...(project?.portState
            ? { portState: safeLabel(project.portState, 'unknown') }
            : {})
        }))
      : [];
    return `${JSON.stringify({
      generatedAt: new Date(this.now()).toISOString(),
      privacy: 'Local diagnostics exclude project names, folders, commands, environment values, ports, process IDs, and process output.',
      environment: this.environment,
      summary: {
        projectCount: safeCount(snapshot.projectCount ?? projects.length),
        ownershipCount: safeCount(snapshot.ownershipCount),
        reservationCount: safeCount(snapshot.reservationCount),
        localProcessCount: safeCount(snapshot.localProcessCount)
      },
      projects,
      recentEvents: this.events.map((event) => ({ ...event }))
    }, null, 2)}\n`;
  }

  projectRef(projectId) {
    return crypto.createHash('sha256')
      .update(this.projectSalt)
      .update('\0')
      .update(String(projectId ?? 'unknown'))
      .digest('hex')
      .slice(0, 12);
  }
}

function safeSnapshot(snapshot) {
  if (typeof snapshot !== 'function') {
    return {};
  }
  try {
    const value = snapshot();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function copySafeDetails(target, details, traceEnabled) {
  for (const key of [
    'outcome',
    'status',
    'previousStatus',
    'resultingStatus',
    'reasonCode',
    'identityDecision',
    'lockKind',
    'processState',
    'portState',
    'signal'
  ]) {
    if (details[key] !== undefined) {
      target[key] = safeLabel(details[key], 'unknown');
    }
  }
  for (const key of ['exitCode', 'serviceCount', 'processCount', 'attemptCount']) {
    if (Number.isInteger(details[key])) {
      target[key] = details[key];
    }
  }
  for (const key of ['ownershipPresent', 'reservationPresent', 'localProcess', 'processActive']) {
    if (typeof details[key] === 'boolean') {
      target[key] = details[key];
    }
  }
  if (details.error) {
    target.errorCode = safeLabel(details.error.code, 'error');
    if (traceEnabled) {
      target.detail = redactDiagnosticDetail(details.error.message);
    }
  } else if (traceEnabled && details.detail) {
    target.detail = redactDiagnosticDetail(details.detail);
  }
}

function redactDiagnosticDetail(value) {
  return redactSensitiveText(value)
    .replace(/file:\/\/\/?[^\s"'<>]+/gi, '[path]')
    .replace(/[A-Za-z]:\\[^\r\n]*/g, '[path]')
    .replace(/\/(?:Users|home|private|tmp|var|opt|etc)\/[^\r\n]*/gi, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_CHARS);
}

function normalizeEnvironment(environment = {}) {
  return {
    runlistVersion: safeVersion(environment.runlistVersion),
    vscodeVersion: safeVersion(environment.vscodeVersion),
    platform: safeLabel(environment.platform || process.platform, 'unknown'),
    arch: safeLabel(environment.arch || process.arch, 'unknown'),
    remoteKind: safeLabel(environment.remoteKind || 'local', 'unknown')
  };
}

function safeVersion(value) {
  const text = String(value || 'unknown').trim();
  return /^[0-9A-Za-z.+_-]{1,64}$/.test(text) ? text : 'unknown';
}

function safeLabel(value, fallback) {
  const text = String(value || '').trim();
  return SAFE_LABEL.test(text) ? text : fallback;
}

function safeOperationId(value) {
  const text = String(value || '').trim();
  return /^[a-f0-9-]{8,64}$/i.test(text) ? text : undefined;
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
}

module.exports = {
  MAX_EVENTS,
  RunlistDiagnostics,
  redactDiagnosticDetail
};
