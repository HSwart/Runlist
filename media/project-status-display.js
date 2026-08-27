(function exposeProjectStatusDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.RunlistProjectStatus = api;
  }
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const PRIMARY_STATUS_CODES = new Set([
    'running',
    'starting',
    'stopping',
    'stopped',
    'review-required',
    'port-in-use',
    'port-in-use-unknown'
  ]);

  function projectStatusFullLabels(project = {}) {
    const conflict = project.portConflict;
    const conflictOwnerName = conflict?.ownerName || 'Another app';
    const blockedServiceCount = (project.services || [])
      .filter((service) => project.openPorts?.includes(service.port)).length;
    const blockedServiceLabel = `${blockedServiceCount || 1} ${blockedServiceCount === 1 ? 'service' : 'services'} blocked`;
    return {
      running: 'Running',
      starting: 'Starting…',
      'not-ready': 'Taking longer…',
      'not-responding': 'Web service not responding',
      'ownership-lost': 'Running — control unavailable',
      stopping: 'Stopping…',
      active: project.httpUnresponsive ? 'Detected, web service not responding' : 'Detected',
      'port-in-use': conflict?.ownerName ? `${blockedServiceLabel} by ${conflictOwnerName}` : blockedServiceLabel,
      'port-in-use-unknown': blockedServiceLabel,
      'review-required': 'Review setup',
      unsupported: 'Local lifecycle only',
      stopped: 'Stopped'
    };
  }

  function projectStatusCode(project = {}) {
    return project.reviewRequired ? 'review-required' : (project.status || 'stopped');
  }

  function projectPrimaryStatusCode(project = {}) {
    if (project.forceClosing || project.handoffInProgress) {
      return projectStatusCode(project);
    }
    const code = projectStatusCode(project);
    if (code === 'not-ready') {
      return 'starting';
    }
    if (code === 'not-responding') {
      return 'running';
    }
    return code;
  }

  function projectStartFailureText(project = {}) {
    if (project.forceClosing || project.handoffInProgress || project.reviewRequired) {
      return '';
    }
    if (projectStatusCode(project) !== 'stopped') {
      return '';
    }
    const summary = project.failureSummary;
    if (!summary || typeof summary !== 'object') {
      return '';
    }
    const message = String(summary.message || '').trim();
    const title = String(summary.title || '').trim();
    return message || title || 'Start failed';
  }

  function projectStopFailureText(project = {}) {
    if (project.forceClosing || project.handoffInProgress || project.reviewRequired) {
      return '';
    }
    const code = projectStatusCode(project);
    if (code === 'stopped' || code === 'stopping') {
      return '';
    }
    return String(project.stopFailure || '').trim();
  }

  function projectDisplayedStatus(project = {}) {
    const fullLabels = projectStatusFullLabels(project);
    const conflictOwnerName = project.portConflict?.ownerName || 'Another app';
    if (project.forceClosing) {
      return 'Closing processes…';
    }
    if (project.handoffInProgress) {
      return `Switching from ${conflictOwnerName}…`;
    }
    const stopFailure = projectStopFailureText(project);
    if (stopFailure) {
      return stopFailure;
    }
    const startFailure = projectStartFailureText(project);
    if (startFailure) {
      return startFailure;
    }
    const code = projectStatusCode(project);
    const primaryCode = projectPrimaryStatusCode(project);
    if (PRIMARY_STATUS_CODES.has(primaryCode)) {
      return fullLabels[primaryCode];
    }
    if (code === 'active') {
      return 'Detected';
    }
    if (code === 'ownership-lost') {
      return 'Unavailable';
    }
    if (code === 'unsupported') {
      return 'Local only';
    }
    return fullLabels.stopped;
  }

  function serviceReadinessDetailsText(project = {}, status) {
    if (!['not-ready', 'not-responding'].includes(status)) {
      return '';
    }
    const details = project.serviceReadiness || {};
    const rows = [];
    const ready = details.ready || [];
    const waiting = details.waiting || [];
    const notResponding = details.notResponding || [];
    if (ready.length) {
      rows.push(`Ready: ${ready.map((service) => `${service.name} :${service.port}`).join(', ')}`);
    }
    if (waiting.length) {
      rows.push(`Still checking: ${waiting.map((service) => `${service.name} :${service.port}`).join(', ')}`);
    }
    if (notResponding.length) {
      rows.push(`Waiting for web response: ${notResponding.map((service) => `${service.name} :${service.port}`).join(', ')}`);
    }
    return rows.join('. ');
  }

  function projectStatusDetailText(project = {}) {
    if (project.forceClosing || project.handoffInProgress) {
      return '';
    }
    const code = projectStatusCode(project);
    const fullLabels = projectStatusFullLabels(project);
    const primary = projectDisplayedStatus(project);
    const parts = [];
    if (fullLabels[code] && fullLabels[code] !== primary
      && !projectStartFailureText(project)
      && !projectStopFailureText(project)) {
      parts.push(fullLabels[code]);
    }
    const readiness = serviceReadinessDetailsText(project, project.status || 'stopped');
    if (readiness) {
      parts.push(readiness);
    }
    return parts.join(' ');
  }

  function projectStatusAnnouncement(project = {}) {
    const name = project.name || 'Project';
    const composeLabel = typeof project.composePath === 'string' && project.composePath.trim()
      ? 'Compose project. '
      : '';
    if (project.forceClosing || project.handoffInProgress) {
      return `${composeLabel}${name}: ${projectDisplayedStatus(project)}`;
    }
    const fullLabels = projectStatusFullLabels(project);
    const failureText = projectStopFailureText(project) || projectStartFailureText(project);
    const spokenStatus = failureText
      || fullLabels[projectStatusCode(project)]
      || projectDisplayedStatus(project)
      || 'Stopped';
    const readiness = serviceReadinessDetailsText(project, project.status || 'stopped');
    const ownerAnnouncement = typeof project.listenerOwner?.announcement === 'string'
      && project.listenerOwner.announcement.trim()
      ? project.listenerOwner.announcement.trim()
      : '';
    return `${composeLabel}${name}: ${spokenStatus}${readiness ? ` ${readiness}` : ''}${ownerAnnouncement ? ` ${ownerAnnouncement}` : ''}`;
  }

  return {
    projectDisplayedStatus,
    projectPrimaryStatusCode,
    projectStartFailureText,
    projectStatusAnnouncement,
    projectStatusCode,
    projectStatusDetailText,
    projectStatusFullLabels,
    projectStopFailureText
  };
}));
