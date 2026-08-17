const DEFAULT_RUNTIME_PULSE_LIMIT = 12;

class HttpResponseHistory {
  constructor(limit = DEFAULT_RUNTIME_PULSE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('HTTP response history limit must be a positive integer.');
    }
    this.limit = limit;
    this.history = new Map();
  }

  append(projectId, responseTimeMs) {
    if (!Number.isFinite(responseTimeMs) || responseTimeMs < 0) {
      this.clear(projectId);
      return [];
    }
    const samples = this.history.get(projectId) || [];
    samples.push({ responseTimeMs: Math.max(1, Math.round(responseTimeMs)) });
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

class RuntimePulseHistory {
  constructor(limit = DEFAULT_RUNTIME_PULSE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('Runtime pulse limit must be a positive integer.');
    }
    this.limit = limit;
    this.history = new Map();
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

    const samples = this.history.get(projectId) || [];
    samples.push({ cpuPercent, memoryBytes });
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

module.exports = {
  DEFAULT_RUNTIME_PULSE_LIMIT,
  HttpResponseHistory,
  RuntimePulseHistory
};
