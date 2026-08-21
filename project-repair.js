const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readProjectDiagnostics } = require('./project-diagnostics');
const { normalizeProjectInput, readProjects, upsertProject } = require('./project-store');

const PROJECT_REPAIR_SCHEMA_VERSION = 1;
const PROPOSAL_KEYS = new Set([
  'name',
  'folder',
  'startCommand',
  'stopCommand',
  'services'
]);

class ProjectRepairError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProjectRepairError';
    this.code = code;
  }
}

function projectConfigurationRevision(project) {
  const configuration = {
    name: project.name,
    folder: project.folder,
    startCommand: project.startCommand,
    stopCommand: project.stopCommand || '',
    reviewRequired: project.reviewRequired === true,
    services: (project.services || []).map((service) => ({
      name: service.name,
      port: service.port,
      portVariable: service.portVariable || '',
      url: service.url || ''
    }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

function createProjectRepairProposal(projectsFile, input) {
  validateProposalEnvelope(input);
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
    ...project,
    ...input.proposal,
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
    projectId: project.id,
    projectRevision: input.projectRevision,
    failedAt: input.failedAt,
    proposedProject,
    createdAt: Date.now()
  };
  writeProposal(projectsFile, record);
  return record;
}

function approveProjectRepairProposal(projectsFile, projectId) {
  const proposal = readProjectRepairProposal(projectsFile, projectId);
  if (!proposal) {
    throw repairError('PROPOSAL_NOT_FOUND', 'This repair proposal is no longer available.');
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
    id: projectId
  }, { allowStoredName: true, reviewRequired: false }).project;
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

function projectRepairComparison(current, proposed) {
  const comparison = [
    compareValue('Name', current.name, proposed.name),
    compareValue('Folder', current.folder, proposed.folder),
    compareValue('Start command', current.startCommand, proposed.startCommand),
    compareValue('Stop command', current.stopCommand, proposed.stopCommand)
  ];
  const currentServices = new Map((current.services || [])
    .map((service) => [service.name.toLocaleLowerCase(), service]));
  const proposedServices = new Map((proposed.services || [])
    .map((service) => [service.name.toLocaleLowerCase(), service]));
  const serviceNames = new Set([...currentServices.keys(), ...proposedServices.keys()]);
  for (const name of serviceNames) {
    const currentService = currentServices.get(name);
    const proposedService = proposedServices.get(name);
    comparison.push(compareValue(
      `Service: ${proposedService?.name || currentService?.name}`,
      formatService(currentService),
      formatService(proposedService)
    ));
  }
  const currentOrder = (current.services || []).map((service) => service.name).join(' → ');
  const proposedOrder = (proposed.services || []).map((service) => service.name).join(' → ');
  if (currentOrder !== proposedOrder
    && [...currentServices.keys()].every((name) => proposedServices.has(name))
    && currentServices.size === proposedServices.size) {
    comparison.push(compareValue('Service order', currentOrder, proposedOrder));
  }
  return comparison;
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

function formatService(service) {
  if (!service) {
    return '';
  }
  const url = service.url || `http://localhost:${service.port}`;
  const portVariable = service.portVariable ? ` · temporary via ${service.portVariable}` : '';
  return `${service.name} :${service.port} — ${url}${portVariable}`;
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
  if (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 200) {
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
  readProjectRepairProposal
};
