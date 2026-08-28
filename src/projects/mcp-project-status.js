const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { projectLifecycleCapability } = require('../lifecycle/lifecycle-capability');
const {
  readProjectDiagnostics,
  redactSensitiveText
} = require('./project-diagnostics');
const {
  projectConfigurationRevision,
  readProjectRepairProposal
} = require('./project-repair');

const MAX_LISTED_PROJECTS = 64;
const READINESS_HINT = 'Configured ports are saved setup, not proof that a process is listening or that Runlist owns it.';
const OBSERVED_LIFECYCLE_STATES = new Set([
  'starting',
  'running',
  'active',
  'stopping',
  'stopped',
  'not-ready',
  'not-responding',
  'ownership-lost'
]);

function ownershipRecordPath(ownershipDirectory, projectId) {
  const fileName = crypto.createHash('sha256').update(String(projectId)).digest('hex');
  return path.join(ownershipDirectory, `${fileName}.json`);
}

function readObservedLifecycleState(ownershipDirectory, projectId) {
  if (!ownershipDirectory) {
    return 'stopped';
  }
  try {
    const record = JSON.parse(fs.readFileSync(ownershipRecordPath(ownershipDirectory, projectId), 'utf8'));
    if (!record || record.projectId !== projectId) {
      return 'stopped';
    }
    const state = String(record.state || '').slice(0, 64);
    return OBSERVED_LIFECYCLE_STATES.has(state) ? state : 'stopped';
  } catch {
    return 'stopped';
  }
}

function windowLifecycleSupported(env = process.env) {
  return env.RUNLIST_WINDOW_LIFECYCLE_SUPPORTED !== '0';
}

function projectControllableInThisWindow(project, options = {}) {
  if (project?.reviewRequired === true) {
    return false;
  }
  if (options.windowLifecycleSupported === false) {
    return false;
  }
  return projectLifecycleCapability(
    { supported: true, kind: 'local' },
    project,
    options.platform || process.platform
  ).supported === true;
}

function listedServices(project) {
  if (!Array.isArray(project?.services)) {
    return [];
  }
  return project.services.slice(0, 32).map((service) => ({
    name: String(service?.name || '').slice(0, 64),
    port: Number(service?.port),
    ...(typeof service?.url === 'string' && service.url
      ? { url: redactSensitiveText(service.url).slice(0, 2048) }
      : {})
  })).filter((service) => Number.isInteger(service.port) && service.port >= 1 && service.port <= 65535);
}

function listedProject(project, options = {}) {
  return {
    id: String(project.id),
    name: String(project.name || '').slice(0, 200),
    folder: String(project.folder || '').slice(0, 4096),
    reviewRequired: project.reviewRequired === true,
    services: listedServices(project),
    observedLifecycleState: readObservedLifecycleState(options.ownershipDirectory, project.id),
    controllableInThisWindow: projectControllableInThisWindow(project, options)
  };
}

function buildListedProjects(projects, options = {}) {
  const source = Array.isArray(projects) ? projects : [];
  const truncated = source.length > MAX_LISTED_PROJECTS;
  return {
    projects: source.slice(0, MAX_LISTED_PROJECTS).map((project) => listedProject(project, options)),
    truncated,
    note: 'Lifecycle state comes from the shared ownership file and may differ in another VS Code window. These tools never start, stop, or close ports.'
  };
}

function boundedFailureSummary(diagnostic) {
  if (!diagnostic?.failureSummary) {
    return undefined;
  }
  return {
    title: redactSensitiveText(diagnostic.failureSummary.title || 'Start failed').slice(0, 120),
    message: redactSensitiveText(diagnostic.failureSummary.message || 'The start command did not complete.').slice(0, 1000),
    ...(diagnostic.failureSummary.outcome
      ? { outcome: redactSensitiveText(diagnostic.failureSummary.outcome).slice(0, 240) }
      : {})
  };
}

function buildProjectStatus(project, options = {}) {
  const diagnostic = options.projectsFile
    ? readProjectDiagnostics(options.projectsFile, project.id)
    : undefined;
  const repair = options.projectsFile
    ? readProjectRepairProposal(options.projectsFile, project.id)
    : undefined;
  const services = listedServices(project);
  const failureSummary = boundedFailureSummary(diagnostic);
  return {
    id: String(project.id),
    name: String(project.name || '').slice(0, 200),
    folder: String(project.folder || '').slice(0, 4096),
    reviewRequired: project.reviewRequired === true,
    observedLifecycleState: readObservedLifecycleState(options.ownershipDirectory, project.id),
    controllableInThisWindow: projectControllableInThisWindow(project, options),
    configuredPorts: services.map((service) => service.port),
    services,
    readinessHint: READINESS_HINT,
    diagnosticsAvailable: Boolean(diagnostic),
    repairAvailable: Boolean(repair),
    projectRevision: projectConfigurationRevision(project),
    ...(failureSummary ? { failureSummary } : {}),
    ...(Number.isFinite(diagnostic?.failedAt) ? { failedAt: diagnostic.failedAt } : {}),
    note: 'This status is read-only. Start, stop, and repair apply only from the Runlist sidebar after you confirm them.'
  };
}

module.exports = {
  MAX_LISTED_PROJECTS,
  READINESS_HINT,
  buildListedProjects,
  buildProjectStatus,
  ownershipRecordPath,
  projectControllableInThisWindow,
  readObservedLifecycleState,
  windowLifecycleSupported
};
