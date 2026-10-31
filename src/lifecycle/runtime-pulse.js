const DEFAULT_RUNTIME_PULSE_LIMIT = 12;

class SampleHistory {
  constructor(limit = DEFAULT_RUNTIME_PULSE_LIMIT, label = 'Sample history') {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError(`${label} limit must be a positive integer.`);
    }
    this.limit = limit;
    this.history = new Map();
  }

  appendSample(projectId, sample) {
    const samples = this.history.get(projectId) || [];
    samples.push(sample);
    if (samples.length > this.limit) {
      samples.splice(0, samples.length - this.limit);
    }
    this.history.set(projectId, samples);
    return this.get(projectId);
  }

  get(projectId) {
    return (this.history.get(projectId) || []).map((sample) => ({ ...sample }));
  }

  clear(projectId) {
    this.history.delete(projectId);
  }
}

class HttpResponseHistory extends SampleHistory {
  constructor(limit = DEFAULT_RUNTIME_PULSE_LIMIT) {
    super(limit, 'HTTP response history');
    this.target = undefined;
  }

  setTarget(projectId, port, url) {
    const next = projectId && Number.isInteger(port) && typeof url === 'string'
      ? { projectId, port, url }
      : undefined;
    if (this.target?.projectId === next?.projectId
      && this.target?.port === next?.port
      && this.target?.url === next?.url) {
      return;
    }
    if (this.target?.projectId) {
      this.clear(this.target.projectId);
    }
    if (next?.projectId) {
      this.clear(next.projectId);
    }
    this.target = next;
  }

  currentTarget() {
    return this.target ? { ...this.target } : undefined;
  }

  record(status, responses) {
    const target = this.target;
    if (!target) {
      return [];
    }
    const response = (responses || []).find((item) => item.port === target.port
      && item.url === target.url);
    if (!['running', 'active'].includes(status) || !response) {
      this.clear(target.projectId);
      return [];
    }
    return this.append(target.projectId, response.responseTimeMs);
  }

  append(projectId, responseTimeMs) {
    if (!Number.isFinite(responseTimeMs) || responseTimeMs < 0) {
      this.clear(projectId);
      return [];
    }
    return this.appendSample(projectId, {
      responseTimeMs: Math.max(1, Math.round(responseTimeMs))
    });
  }
}

class RuntimePulseHistory extends SampleHistory {
  constructor(limit = DEFAULT_RUNTIME_PULSE_LIMIT) {
    super(limit, 'Runtime pulse');
  }

  append(projectId, metrics) {
    if (!metrics?.available) {
      this.clear(projectId);
      return [];
    }
    if (metrics.measuring) {
      return this.get(projectId);
    }

    const cpuPercent = Number.isFinite(metrics.cpuPercent)
      ? Math.max(0, metrics.cpuPercent)
      : undefined;
    const memoryBytes = Number.isFinite(metrics.memoryBytes)
      ? Math.max(0, metrics.memoryBytes)
      : undefined;
    if (cpuPercent === undefined && memoryBytes === undefined) {
      return this.get(projectId);
    }

    return this.appendSample(projectId, { cpuPercent, memoryBytes });
  }
}

module.exports = {
  HttpResponseHistory,
  RuntimePulseHistory
};
