const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OWNER_HEARTBEAT_TIMEOUT_MS = 30_000;

function projectKey(projectId) {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex');
}

function validOwnership(value, projectId) {
  return Boolean(value
    && typeof value.projectId === 'string'
    && (!projectId || value.projectId === projectId)
    && Number.isInteger(value.hostPid)
    && value.hostPid > 0
    && typeof value.token === 'string');
}

function readJsonRecord(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function ownerHeartbeatFresh(ownership, now = Date.now()) {
  return Number.isFinite(ownership?.heartbeatAt)
    && now - ownership.heartbeatAt <= OWNER_HEARTBEAT_TIMEOUT_MS;
}

function readPersistedOwnershipSnapshot(projectsFile, projectId, now = Date.now()) {
  const projects = new Map();
  if (!projectsFile) {
    return projects;
  }
  const directory = path.join(path.dirname(projectsFile), 'process-ownership');
  if (!fs.existsSync(directory)) {
    return projects;
  }
  for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const ownershipPath = path.join(directory, filename);
    const ownership = readJsonRecord(ownershipPath);
    if (!validOwnership(ownership)) {
      continue;
    }
    if (projectId && ownership.projectId !== projectId) {
      continue;
    }
    const stopRequested = readJsonRecord(path.join(directory, `${projectKey(ownership.projectId)}.stop`))?.token
      === ownership.token;
    projects.set(ownership.projectId, {
      ...ownership,
      ownerHeartbeatFresh: ownerHeartbeatFresh(ownership, now),
      state: stopRequested ? 'stopping' : ownership.state
    });
  }
  return projects;
}

module.exports = {
  OWNER_HEARTBEAT_TIMEOUT_MS,
  readPersistedOwnershipSnapshot
};
