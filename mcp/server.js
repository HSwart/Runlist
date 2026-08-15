#!/usr/bin/env node
const readline = require('readline');
const { upsertProject } = require('../project-store');

const SERVER_NAME = 'switchboard-mcp-server';
const SERVER_VERSION = '0.0.1';
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
]);
const PROJECTS_FILE = process.env.SWITCHBOARD_PROJECTS_FILE;

const tool = {
  name: 'switchboard_setup_project',
  title: 'Set up a Switchboard project',
  description: 'Add a local project to Switchboard, or update the existing entry for the same folder. You may give the project a friendly custom name. Before calling, identify every service the project starts and provide its explicit port. The saved commands remain blocked until the user reviews and approves them in Switchboard.',
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
        description: 'Shell command Switchboard should execute to start this project.'
      },
      stopCommand: {
        type: 'string',
        description: 'Optional custom shell command for detached services, containers, or other advanced shutdown needs. Omit it to stop only the process tree Switchboard launches.'
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
                port: { type: 'integer' }
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
    title: 'Set up a Switchboard project',
    readOnlyHint: false,
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
          title: 'Switchboard',
          version: SERVER_VERSION,
          description: 'Adds local projects to the Switchboard VS Code extension.'
        },
        instructions: 'Use switchboard_setup_project when the user asks to save a local project in Switchboard. Inspect the project first, identify every service it starts, and provide the absolute folder path, exact start command, and an explicit unique port for each service. Provide a custom stop command only when the project needs an advanced shutdown workflow, such as a detached service or container. You may also provide a friendly custom project name when the user requests one. Tell the user that Switchboard will require them to review and approve the saved setup before its commands can run.'
      });
      break;
    case 'ping':
      result(message.id, {});
      break;
    case 'tools/list':
      result(message.id, { tools: [tool] });
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
  if (name !== tool.name) {
    error(message.id, -32602, `Unknown tool: ${name || '(missing)'}`);
    return;
  }
  if (!PROJECTS_FILE) {
    toolError(message.id, 'Switchboard storage is unavailable. Restart VS Code and try again.');
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
    if (!Object.prototype.hasOwnProperty.call(argumentsValue, 'services')) {
      throw new Error('services must list at least one service and port.');
    }

    const saved = upsertProject(PROJECTS_FILE, argumentsValue, { reviewRequired: true });
    const structuredContent = {
      action: saved.action,
      project: saved.project
    };
    result(message.id, {
      content: [{
        type: 'text',
        text: `${saved.project.name} was ${saved.action} in Switchboard. The user must review and approve its folder and commands in the Switchboard sidebar before Start or Stop is available.\n${JSON.stringify(structuredContent)}`
      }],
      structuredContent,
      isError: false
    });
  } catch (toolFailure) {
    toolError(message.id, `Could not set up the Switchboard project: ${toolFailure.message}`);
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
