const { safeServiceUrl } = require('./external-url');

function previewFrameSource(value) {
  const safeUrl = safeServiceUrl(value);
  if (!safeUrl) {
    return "'none'";
  }
  return new URL(safeUrl).origin;
}

function projectPreviewService(project, status, serviceUrls, conflicted = false) {
  if (!project || project.reviewRequired || conflicted
    || !['running', 'starting', 'not-ready', 'not-responding', 'active'].includes(status)) {
    return undefined;
  }
  const reachableByPort = new Map((serviceUrls || [])
    .map((entry) => [entry.port, safeServiceUrl(entry.url)]));
  for (const service of project.services || []) {
    const url = reachableByPort.get(service.port);
    if (url) {
      return { port: service.port, url };
    }
  }
  return undefined;
}

function projectPreviewUrl(project, status, serviceUrls, conflicted = false) {
  return projectPreviewService(project, status, serviceUrls, conflicted)?.url;
}

module.exports = { previewFrameSource, projectPreviewService, projectPreviewUrl };
