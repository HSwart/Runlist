#!/usr/bin/env node
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const {
  boundedDiagnosticOutput,
  readProjectDiagnostics,
  redactSensitiveText
} = require('../project-diagnostics');
const { ProcessOwnershipStore } = require('../project-process');
const { findProjectByFolder, upsertProject } = require('../project-store');
const { version: SERVER_VERSION } = require('../package.json');

const SERVER_NAME = 'runlist-mcp-server';
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
]);
const PROJECTS_FILE = process.env.RUNLIST_PROJECTS_FILE;
const processOwnership = PROJECTS_FILE
  ? new ProcessOwnershipStore(path.join(path.dirname(PROJECTS_FILE), 'process-ownership'))
  : undefined;

const setupTool = {
  name: 'runlist_setup_project',
  title: 'Set up a Runlist project',
  description: 'Add a local project to Runlist, or update the existing entry for the same folder. You may give the project a friendly custom name and an advanced custom stop command. Runlist normally stops only the process tree it launched. Before calling, identify every service the project starts and provide its explicit port. When the project explicitly defines an HTTP or HTTPS browser URL for a service, you may include it as an override. The saved setup remains blocked until the user reviews and approves it in Runlist.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        maxLength: 100,
        description: 'Optional friendly project name. Omit it to keep the existing name or use the folder name for a new project.'
      },
      folder: {
        type: 'string',
        description: 'Absolute path to the existing local project folder.'
      },
      startCommand: {
        type: 'string',
        description: 'Shell command Runlist should execute to start this project.'
      },
      stopCommand: {
        type: 'string',
        description: 'Optional advanced custom shell command for projects that daemonize or manage external services such as Docker or databases. Omit it for ordinary development servers so Runlist stops only its launched process tree.'
      },
      services: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        description: 'Complete list of services started by this project. Every service must have an explicit unique port.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              description: 'Short service name, for example web, api, or storybook.'
            },
            port: {
              type: 'integer',
              minimum: 1,
              maximum: 65535,
              description: 'TCP port used by this service.'
            },
            url: {
              type: 'string',
              maxLength: 2048,
              description: 'Optional explicit HTTP or HTTPS URL to open for this service, including any custom hostname or path. Omit it to use the localhost URL derived from the port.'
            }
          },
          required: ['name', 'port'],
          additionalProperties: false
        }
      }
    },
    required: ['folder', 'startCommand', 'services'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['created', 'updated'] },
      project: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          folder: { type: 'string' },
          startCommand: { type: 'string' },
          stopCommand: { type: 'string' },
          reviewRequired: { type: 'boolean' },
          services: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                port: { type: 'integer' },
                url: { type: 'string' }
              },
              required: ['name', 'port'],
              additionalProperties: false
            }
          }
        },
        required: ['id', 'name', 'folder', 'startCommand', 'services', 'reviewRequired'],
        additionalProperties: false
      }
    },
    required: ['action', 'project'],
    additionalProperties: false
  },
  annotations: {
    title: 'Set up a Runlist project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

const diagnosticsTool = {
  name: 'runlist_get_project_diagnostics',
  title: 'Get Runlist start diagnostics',
  description: 'Return bounded, sanitized diagnostics for one explicitly selected saved Runlist project after its latest start failed. This tool is read-only and does not inspect project files, environment variables, processes, or network data.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Exact Runlist project ID supplied by the Runlist diagnosis screen.'
      }
    },
    required: ['projectId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          folder: { type: 'string' },
          startCommand: { type: 'string' },
          services: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                port: { type: 'integer' },
                url: { type: 'string' }
              },
              required: ['name', 'port'],
              additionalProperties: false
            }
          }
        },
        required: ['id', 'name', 'folder', 'startCommand', 'services'],
        additionalProperties: false
      },
      platform: { type: 'string' },
      observedLifecycleState: { type: 'string' },
      exitCode: { type: ['integer', 'null'] },
      signal: { type: ['string', 'null'] },
      failureSummary: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          outcome: { type: 'string' }
        },
        required: ['title', 'message'],
        additionalProperties: false
      },
      retainedOutput: { type: 'string', maxLength: 12000 },
      outputTruncated: { type: 'boolean' },
      failedAt: { type: 'number' }
    },
    required: [
      'project',
      'platform',
      'observedLifecycleState',
      'exitCode',
      'signal',
      'failureSummary',
      'retainedOutput',
      'outputTruncated',
      'failedAt'
    ],
    additionalProperties: false
  },
  annotations: {
    title: 'Get Runlist start diagnostics',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolError(id, message) {
  result(id, {
    content: [{ type: 'text', text: message }],
    isError: true
  });
}

function handleRequest(message) {
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (hasId) {
      error(message.id, -32600, 'Invalid JSON-RPC request.');
    }
    return;
  }

  if (!hasId) {
    return;
  }

  switch (message.method) {
    case 'initialize':
      result(message.id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(message.params?.protocolVersion)
          ? message.params.protocolVersion
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_NAME,
          title: 'Runlist',
          version: SERVER_VERSION,
          description: 'Adds local projects to the Runlist VS Code extension.'
        },
        instructions: 'Use runlist_setup_project when the user asks to save a local project in Runlist. Inspect the project first, identify every service it starts, and provide the absolute folder path, exact start command, and an explicit unique port for each service. Include an optional HTTP or HTTPS service URL only when the project defines it explicitly; never guess one. Omit stopCommand for ordinary development servers so Runlist stops only the process tree it launched. Provide a custom stop command only when the project daemonizes or manages external services such as Docker or databases. You may also provide a friendly custom project name when the user requests one. Tell the user that Runlist will require them to review and approve the saved setup before its commands can run. Use runlist_get_project_diagnostics only when the user supplies a project ID copied from Runlist after a failed start. Diagnose the returned context without reading other projects or changing the saved setup. Any proposed setup change must still be saved through runlist_setup_project for explicit review and approval in Runlist.'
      });
      break;
    case 'ping':
      result(message.id, {});
      break;
    case 'tools/list':
      result(message.id, { tools: [setupTool, diagnosticsTool] });
      break;
    case 'tools/call':
      callTool(message);
      break;
    default:
      error(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function callTool(message) {
  const name = message.params?.name;
  if (name === diagnosticsTool.name) {
    callDiagnosticsTool(message);
    return;
  }
  if (name !== setupTool.name) {
    error(message.id, -32602, `Unknown tool: ${name || '(missing)'}`);
    return;
  }
  if (!PROJECTS_FILE) {
    toolError(message.id, 'Runlist storage is unavailable. Restart VS Code and try again.');
    return;
  }

  try {
    const argumentsValue = message.params?.arguments;
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      throw new Error('arguments must be an object.');
    }
    const allowedKeys = new Set(['name', 'folder', 'startCommand', 'stopCommand', 'services']);
    const unsupportedKeys = Object.keys(argumentsValue).filter((key) => !allowedKeys.has(key));
    if (unsupportedKeys.length) {
      throw new Error(`unsupported argument: ${unsupportedKeys.join(', ')}`);
    }
    if (!Array.isArray(argumentsValue.services) || argumentsValue.services.length === 0) {
      throw new Error('services must list at least one service and port.');
    }

    const existingProject = findProjectByFolder(PROJECTS_FILE, argumentsValue.folder);
    let updateReserved = false;
    if (existingProject) {
      const ownershipConflict = processOwnership.reserve(existingProject.id);
      if (ownershipConflict) {
        throw new Error(`Stop ${existingProject.name} before asking an agent to update its setup.`);
      }
      updateReserved = true;
    }

    let saved;
    try {
      saved = upsertProject(PROJECTS_FILE, argumentsValue, { reviewRequired: true });
    } finally {
      if (updateReserved) {
        processOwnership.release(existingProject.id);
      }
    }
    const structuredContent = {
      action: saved.action,
      project: saved.project
    };
    result(message.id, {
      content: [{
        type: 'text',
        text: `${saved.project.name} was ${saved.action} in Runlist. The user must review and approve its folder and commands in the Runlist sidebar before Start or Stop is available.\n${JSON.stringify(structuredContent)}`
      }],
      structuredContent,
      isError: false
    });
  } catch (toolFailure) {
    toolError(message.id, `Could not set up the Runlist project: ${toolFailure.message}`);
  }
}

function callDiagnosticsTool(message) {
  if (!PROJECTS_FILE) {
    toolError(message.id, 'Runlist storage is unavailable. Restart VS Code and try again.');
    return;
  }

  try {
    const argumentsValue = message.params?.arguments;
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      throw new Error('arguments must be an object.');
    }
    const keys = Object.keys(argumentsValue);
    if (keys.some((key) => key !== 'projectId')) {
      throw new Error('projectId is the only supported argument.');
    }
    const projectId = typeof argumentsValue.projectId === 'string'
      ? argumentsValue.projectId.trim()
      : '';
    if (!projectId || projectId.length > 200) {
      throw new Error('projectId must be the exact ID copied from Runlist.');
    }
    if (!fs.existsSync(PROJECTS_FILE)) {
      throw new Error('Runlist project storage is unavailable.');
    }
    const savedProjects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (!Array.isArray(savedProjects)) {
      throw new Error('Runlist project storage is invalid.');
    }
    const project = savedProjects.find((candidate) => candidate?.id === projectId);
    if (!project) {
      throw new Error('That saved Runlist project was not found.');
    }
    if (project.reviewRequired) {
      throw new Error(`Review and approve ${project.name}'s setup in Runlist before diagnosing it.`);
    }
    const diagnostic = readProjectDiagnostics(PROJECTS_FILE, projectId);
    if (!diagnostic) {
      throw new Error(`${project.name} does not have a retained failed start to diagnose.`);
    }
    const boundedOutput = boundedDiagnosticOutput(diagnostic.retainedOutput);
    const structuredContent = {
      project: {
        id: project.id,
        name: project.name,
        folder: project.folder,
        startCommand: redactSensitiveText(project.startCommand),
        services: Array.isArray(project.services) ? project.services.map((service) => ({
          name: service.name,
          port: service.port
        })) : []
      },
      platform: String(diagnostic.platform || 'unknown').slice(0, 32),
      observedLifecycleState: String(diagnostic.lifecycleState || 'unknown').slice(0, 64),
      exitCode: Number.isInteger(diagnostic.exitCode) ? diagnostic.exitCode : null,
      signal: typeof diagnostic.signal === 'string' ? diagnostic.signal.slice(0, 32) : null,
      failureSummary: {
        title: redactSensitiveText(diagnostic.failureSummary?.title || 'Start failed').slice(0, 120),
        message: redactSensitiveText(diagnostic.failureSummary?.message || 'The start command did not complete.').slice(0, 1000),
        ...(diagnostic.failureSummary?.outcome
          ? { outcome: redactSensitiveText(diagnostic.failureSummary.outcome).slice(0, 240) }
          : {})
      },
      retainedOutput: boundedOutput.output,
      outputTruncated: diagnostic.outputTruncated === true || boundedOutput.truncated,
      failedAt: Number.isFinite(diagnostic.failedAt) ? diagnostic.failedAt : 0
    };
    result(message.id, {
      content: [{
        type: 'text',
        text: `Runlist retained these bounded diagnostics for ${project.name}. No files, environment variables, processes, or network data were inspected.\n${JSON.stringify(structuredContent)}`
      }],
      structuredContent,
      isError: false
    });
  } catch (toolFailure) {
    toolError(message.id, `Could not get Runlist diagnostics: ${toolFailure.message}`);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  try {
    handleRequest(JSON.parse(line));
  } catch {
    error(null, -32700, 'Invalid JSON.');
  }
});
