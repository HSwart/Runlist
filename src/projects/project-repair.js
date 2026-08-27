const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readProjectDiagnostics } = require('./project-diagnostics');
const {
  normalizeProjectInput,
  readProjects,
  upsertProject,
  withProjectStoreLock
} = require('./project-store');
const { rewriteLoopbackServiceUrl } = require('../ports/service-port-overrides');
const { formatCommandForDisplay } = require('./command-display');

const PROJECT_REPAIR_SCHEMA_VERSION = 1;
const PROPOSAL_KEYS = new Set([
  'name',
  'folder',
  'startCommand',
  'stopCommand',
  'services',
  'runtime'
]);

class ProjectRepairError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProjectRepairError';
    this.code = code;
  }
}

function stableEnvFingerprint(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return {};
  }
  return Object.fromEntries(
    Object.keys(env)
      .sort()
      .map((key) => [key, env[key]])
  );
}

function projectConfigurationRevision(project) {
  const configuration = {
    name: project.name,
    folder: project.folder,
    startCommand: project.startCommand,
    stopCommand: project.stopCommand || '',
    runtime: project.runtime || '',
    reviewRequired: project.reviewRequired === true,
    launchProfiles: project.launchProfiles || [],
    tags: project.tags || [],
    envFile: project.envFile || '',
    env: stableEnvFingerprint(project.env),
    requiredEnvKeys: project.requiredEnvKeys || [],
    composePath: project.composePath || '',
    localHostname: project.localHostname || '',
    services: (project.services || []).map((service) => ({
      name: service.name,
      port: service.port,
      portVariable: service.portVariable || '',
      url: service.url || '',
      ...(service.healthCheck ? { healthCheck: service.healthCheck } : {})
    }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

function createProjectRepairProposal(projectsFile, input) {
  validateProposalEnvelope(input);
  return withProjectStoreLock(projectsFile, () => createProjectRepairProposalLocked(
    projectsFile,
    input
  ));
}

function createProjectRepairProposalLocked(projectsFile, input) {
  const projects = readProjects(projectsFile);
  const project = projects.find((candidate) => candidate.id === input.projectId);
  if (!project) {
    throw repairError('PROJECT_NOT_FOUND', 'The selected Runlist project was not found.');
  }
  const diagnostic = readProjectDiagnostics(projectsFile, project.id);
  if (!diagnostic
    || diagnostic.projectRevision !== input.projectRevision
    || diagnostic.failedAt !== input.failedAt) {
    throw repairError('FAILED_START_MISMATCH', 'This proposal does not match the selected retained failed start.');
  }
  if (projectConfigurationRevision(project) !== input.projectRevision) {
    throw repairError('STALE_PROPOSAL', 'The project changed after the diagnostic context was created.');
  }

  const proposedProject = normalizeProjectInput({
    ...projectProposalInput(project, input.proposal, diagnostic.launchProfileId),
    id: project.id
  }, {
    allowStoredName: !Object.hasOwn(input.proposal, 'name'),
    existing: project,
    id: project.id,
    reviewRequired: false
  });
  ensureUniqueProjectFolder(projects, proposedProject);
  if (projectConfigurationRevision(proposedProject) === input.projectRevision) {
    throw repairError('UNCHANGED_PROPOSAL', 'The proposal does not change the saved project setup.');
  }

  const record = {
    schemaVersion: PROJECT_REPAIR_SCHEMA_VERSION,
    proposalId: crypto.randomUUID(),
    projectId: project.id,
    projectRevision: input.projectRevision,
    failedAt: input.failedAt,
    proposedProject,
    createdAt: Date.now()
  };
  writeProposal(projectsFile, record);
  return record;
}

function approveProjectRepairProposal(projectsFile, projectId, proposalId) {
  return withProjectStoreLock(projectsFile, () => approveProjectRepairProposalLocked(
    projectsFile,
    projectId,
    proposalId
  ));
}

function approveProjectRepairProposalLocked(
  projectsFile,
  projectId,
  proposalId,
  { afterProposalRead } = {}
) {
  const proposal = readProjectRepairProposal(projectsFile, projectId);
  if (!proposal) {
    throw repairError('PROPOSAL_NOT_FOUND', 'This repair proposal is no longer available.');
  }
  // Legacy records remain visible for diagnosis, but cannot be approved without a review identity.
  if (!proposal.proposalId) {
    throw repairError(
      'LEGACY_PROPOSAL',
      'This repair proposal predates review identity. Refresh the diagnosis to create a new proposal before approving it.'
    );
  }
  if (typeof proposalId !== 'string' || proposalId.length === 0 || proposalId.length > 256) {
    throw repairError(
      'PROPOSAL_ID_REQUIRED',
      'Select the current repair proposal in Runlist before approving it.'
    );
  }
  if (proposal.proposalId !== proposalId) {
    throw repairError(
      'STALE_PROPOSAL',
      'This repair proposal was replaced after review. Refresh the diagnosis and review the latest proposal before approving it.'
    );
  }
  if (typeof afterProposalRead === 'function') {
    afterProposalRead(proposal);
  }
  const projects = readProjects(projectsFile);
  const project = projects.find((candidate) => candidate.id === projectId);
  const diagnostic = readProjectDiagnostics(projectsFile, projectId);
  if (!project
    || projectConfigurationRevision(project) !== proposal.projectRevision
    || diagnostic?.projectRevision !== proposal.projectRevision
    || diagnostic?.failedAt !== proposal.failedAt) {
    throw repairError('STALE_PROPOSAL', 'The project changed after the failed start. Review a new diagnosis before applying changes.');
  }
  ensureUniqueProjectFolder(projects, proposal.proposedProject);

  const approved = upsertProject(projectsFile, {
    ...proposal.proposedProject,
    id: projectId,
    // Proposed snapshots omit cleared optional fields; pass '' so upsert clears
    // instead of preserving the live project's custom Stop.
    stopCommand: proposal.proposedProject.stopCommand || '',
    pinned: project.pinned === true,
    selectedLaunchProfileId: project.selectedLaunchProfileId || 'default'
  }, { allowStoredName: true, lockHeld: true, reviewRequired: false }).project;
  clearProjectRepairProposal(projectsFile, projectId);
  return approved;
}

function readProjectRepairProposal(projectsFile, projectId) {
  try {
    const record = JSON.parse(fs.readFileSync(proposalPath(projectsFile, projectId), 'utf8'));
    if (!validProposalRecord(record, projectId)) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function clearProjectRepairProposal(projectsFile, projectId) {
  try {
    fs.rmSync(proposalPath(projectsFile, projectId));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function serviceNameKey(name) {
  return String(name).trim().toLowerCase();
}

function projectRepairComparison(current, proposed) {
  const comparison = [
    compareValue('Name', current.name, proposed.name),
    compareValue('Folder', current.folder, proposed.folder),
    compareCommandValue('Start command', current.startCommand, proposed.startCommand),
    compareCommandValue('Stop command', current.stopCommand, proposed.stopCommand),
    compareValue('Runtime', current.runtime, proposed.runtime)
  ];
  appendServiceComparison(comparison, '', current.services, proposed.services);
  const currentProfiles = new Map((current.launchProfiles || []).map((profile) => [profile.id, profile]));
  const proposedProfiles = new Map((proposed.launchProfiles || []).map((profile) => [profile.id, profile]));
  for (const profileId of new Set([...currentProfiles.keys(), ...proposedProfiles.keys()])) {
    const currentProfile = currentProfiles.get(profileId);
    const proposedProfile = proposedProfiles.get(profileId);
    if (JSON.stringify(currentProfile) === JSON.stringify(proposedProfile)) {
      continue;
    }
    const profileName = proposedProfile?.name || currentProfile?.name || 'Removed profile';
    const prefix = `Profile: ${profileName} - `;
    comparison.push(compareCommandValue(
      `${prefix}start command`,
      currentProfile?.startCommand,
      proposedProfile?.startCommand
    ));
    comparison.push(compareCommandValue(
      `${prefix}stop command`,
      currentProfile?.stopCommand,
      proposedProfile?.stopCommand
    ));
    appendServiceComparison(
      comparison,
      prefix,
      currentProfile?.services,
      proposedProfile?.services
    );
  }
  return comparison;
}

function appendServiceComparison(comparison, prefix, currentValue, proposedValue) {
  const currentServices = new Map((currentValue || [])
    .map((service) => [serviceNameKey(service.name), service]));
  const proposedServices = new Map((proposedValue || [])
    .map((service) => [serviceNameKey(service.name), service]));
  const serviceNames = new Set([...currentServices.keys(), ...proposedServices.keys()]);
  for (const name of serviceNames) {
    const currentService = currentServices.get(name);
    const proposedService = proposedServices.get(name);
    comparison.push(compareValue(
      `${prefix}Service: ${proposedService?.name || currentService?.name}`,
      formatService(currentService),
      formatService(proposedService)
    ));
  }
  const currentOrder = (currentValue || []).map((service) => service.name).join(' -> ');
  const proposedOrder = (proposedValue || []).map((service) => service.name).join(' -> ');
  if (currentOrder !== proposedOrder
    && [...currentServices.keys()].every((name) => proposedServices.has(name))
    && currentServices.size === proposedServices.size) {
    comparison.push(compareValue(`${prefix}Service order`, currentOrder, proposedOrder));
  }
}

function compareValue(field, currentValue, proposedValue) {
  const current = currentValue === undefined || currentValue === ''
    ? ''
    : String(currentValue);
  const proposed = proposedValue === undefined || proposedValue === ''
    ? ''
    : String(proposedValue);
  const change = current === proposed
    ? 'unchanged'
    : !current
      ? 'added'
      : !proposed
        ? 'removed'
        : 'changed';
  return {
    field,
    current: current || 'Not set',
    proposed: proposed || 'Not set',
    change
  };
}

function compareCommandValue(field, currentValue, proposedValue) {
  const comparison = compareValue(field, currentValue, proposedValue);
  return {
    ...comparison,
    current: comparison.current === 'Not set'
      ? comparison.current
      : formatCommandForDisplay(comparison.current),
    proposed: comparison.proposed === 'Not set'
      ? comparison.proposed
      : formatCommandForDisplay(comparison.proposed)
  };
}

function formatService(service) {
  if (!service) {
    return '';
  }
  const url = service.url || `http://localhost:${service.port}`;
  const portVariable = service.portVariable ? `; temporary via ${service.portVariable}` : '';
  const healthCheck = formatHealthCheck(service.healthCheck);
  return `${service.name} :${service.port} - ${url}${portVariable}${healthCheck}`;
}

function formatHealthCheck(healthCheck) {
  if (healthCheck?.mode === 'port') {
    return '; health: port only';
  }
  if (healthCheck?.mode !== 'http') {
    return '';
  }
  const target = healthCheck.target || 'service URL';
  const expectedStatus = healthCheck.expectedStatus
    ? `, status ${healthCheck.expectedStatus}`
    : '';
  const timeout = healthCheck.timeoutMs ? `, ${healthCheck.timeoutMs} ms` : '';
  const retries = healthCheck.retries
    ? `, ${healthCheck.retries} ${healthCheck.retries === 1 ? 'retry' : 'retries'}`
    : '';
  return `; health: ${healthCheck.method || 'HEAD'} ${target}${expectedStatus}${timeout}${retries}`;
}

function projectProposalInput(project, proposal, launchProfileId) {
  if (!launchProfileId || launchProfileId === 'default') {
    return {
      ...project,
      ...proposal,
      ...(proposal.services
        ? { services: preserveOmittedServiceMetadata(project.services, proposal.services) }
        : {})
    };
  }
  const launchProfile = (project.launchProfiles || [])
    .find((profile) => profile.id === launchProfileId);
  if (!launchProfile) {
    throw repairError('STALE_PROPOSAL', 'The launch profile used by this failed start is no longer available.');
  }
  const profileKeys = ['startCommand', 'stopCommand', 'services', 'envFile', 'env'];
  const profileChanges = Object.fromEntries(profileKeys
    .filter((key) => Object.hasOwn(proposal, key))
    .map((key) => [
      key,
      key === 'services'
        ? preserveOmittedServiceMetadata(launchProfile.services, proposal.services)
        : proposal[key]
    ]));
  const projectChanges = Object.fromEntries(Object.entries(proposal)
    .filter(([key]) => !profileKeys.includes(key)));
  return {
    ...project,
    ...projectChanges,
    launchProfiles: project.launchProfiles.map((profile) => (
      profile.id === launchProfileId ? { ...profile, ...profileChanges } : profile
    ))
  };
}

function preserveOmittedServiceMetadata(currentServices = [], proposedServices = []) {
  const currentByName = new Map(currentServices.map((service) => [
    serviceNameKey(service.name),
    service
  ]));
  return proposedServices.map((service) => {
    const current = currentByName.get(serviceNameKey(service.name));
    if (!current) {
      return service;
    }
    const healthCheck = !Object.hasOwn(service, 'healthCheck') && current.healthCheck
      ? {
          ...current.healthCheck,
          ...(current.healthCheck.target
            ? {
                target: rewriteLoopbackServiceUrl(
                  current.healthCheck.target,
                  current.port,
                  service.port
                )
              }
            : {})
        }
      : service.healthCheck;
    const preserveUrl = !Object.hasOwn(service, 'url')
      && current.url
      && service.name !== current.name;
    return {
      ...service,
      ...(preserveUrl ? { url: current.url } : {}),
      ...(!Object.hasOwn(service, 'portVariable') && current.portVariable
        ? { portVariable: current.portVariable }
        : {}),
      ...(healthCheck ? { healthCheck } : {})
    };
  });
}

function validateProposalEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw repairError('INVALID_PROPOSAL', 'Repair proposal arguments must be an object.');
  }
  const allowedKeys = new Set(['projectId', 'projectRevision', 'failedAt', 'proposal']);
  const unsupportedEnvelopeKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unsupportedEnvelopeKeys.length) {
    throw repairError('INVALID_PROPOSAL', `Unsupported repair argument: ${unsupportedEnvelopeKeys.join(', ')}.`);
  }
  if (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 256) {
    throw repairError('INVALID_PROPOSAL', 'projectId must identify one saved Runlist project.');
  }
  if (typeof input.projectRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.projectRevision)) {
    throw repairError('INVALID_PROPOSAL', 'projectRevision must be the exact revision returned with the diagnostics.');
  }
  if (!Number.isFinite(input.failedAt)) {
    throw repairError('INVALID_PROPOSAL', 'failedAt must be the exact value returned with the diagnostics.');
  }
  if (!input.proposal || typeof input.proposal !== 'object' || Array.isArray(input.proposal)) {
    throw repairError('INVALID_PROPOSAL', 'proposal must be an object containing setup changes.');
  }
  const proposalKeys = Object.keys(input.proposal);
  const unsupportedKeys = proposalKeys.filter((key) => !PROPOSAL_KEYS.has(key));
  if (unsupportedKeys.length) {
    throw repairError('INVALID_PROPOSAL', `Unsupported proposal field: ${unsupportedKeys.join(', ')}.`);
  }
  if (!proposalKeys.length) {
    throw repairError('INVALID_PROPOSAL', 'proposal must contain at least one setup change.');
  }
}

function ensureUniqueProjectFolder(projects, proposedProject) {
  const folder = folderIdentity(proposedProject.folder);
  const owner = projects.find((project) => (
    project.id !== proposedProject.id && folderIdentity(project.folder) === folder
  ));
  if (owner) {
    throw repairError('FOLDER_CONFLICT', `The proposed folder already belongs to ${owner.name}.`);
  }
}

function folderIdentity(folder) {
  let resolved;
  try {
    resolved = fs.realpathSync(folder);
  } catch {
    resolved = path.resolve(folder);
  }
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function proposalsDirectory(projectsFile) {
  return path.join(path.dirname(projectsFile), 'repair-proposals');
}

function proposalPath(projectsFile, projectId) {
  const name = crypto.createHash('sha256').update(String(projectId)).digest('hex');
  return path.join(proposalsDirectory(projectsFile), `${name}.json`);
}

function writeProposal(projectsFile, record) {
  const directory = proposalsDirectory(projectsFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = proposalPath(projectsFile, record.projectId);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
  }
}

function validProposalRecord(record, projectId) {
  return Boolean(record
    && record.schemaVersion === PROJECT_REPAIR_SCHEMA_VERSION
    && record.projectId === String(projectId)
    && (record.proposalId === undefined
      || (typeof record.proposalId === 'string'
        && /^[0-9a-f-]{36}$/.test(record.proposalId)))
    && typeof record.projectRevision === 'string'
    && /^[a-f0-9]{64}$/.test(record.projectRevision)
    && Number.isFinite(record.failedAt)
    && Number.isFinite(record.createdAt)
    && record.proposedProject
    && typeof record.proposedProject === 'object'
    && !Array.isArray(record.proposedProject));
}

function repairError(code, message, options) {
  return new ProjectRepairError(code, message, options);
}

module.exports = {
  approveProjectRepairProposal,
  clearProjectRepairProposal,
  createProjectRepairProposal,
  ProjectRepairError,
  projectConfigurationRevision,
  projectRepairComparison,
  readProjectRepairProposal,
  serviceNameKey,
  // Test-only seam: callers must use the public approval API in production.
  __test: { approveProjectRepairProposalLocked }
};
