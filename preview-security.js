const { safeServiceUrl } = require('./external-url');

function previewFrameSource(value) {
  const safeUrl = safeServiceUrl(value);
  if (!safeUrl) {
    return "'none'";
  }
  return new URL(safeUrl).origin;
}

function projectPreviewUrl(project, status, serviceUrls, conflicted = false) {
  if (!project || project.reviewRequired || conflicted || !['running', 'active'].includes(status)) {
    return undefined;
  }
  const primaryPort = project.services?.[0]?.port;
  const url = (serviceUrls || []).find((entry) => entry.port === primaryPort)?.url;
  return safeServiceUrl(url);
}

module.exports = { previewFrameSource, projectPreviewUrl };
