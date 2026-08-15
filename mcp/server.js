#!/usr/bin/env node
const readline = require('readline');
const { upsertProject } = require('../project-store');

const SERVER_NAME = 'porter-mcp-server';
const SERVER_VERSION = '0.0.1';
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
]);
const PROJECTS_FILE = process.env.PORTER_PROJECTS_FILE;

const tool = {
  name: 'porter_setup_project',
  title: 'Set up a Porter project',
  description: 'Add a local project to Porter, or update the existing entry for the same folder. Stores the start and stop commands that Porter may execute later when the user clicks Start or Stop.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'Absolute path to the existing local project folder.'
      },
      startCommand: {
        type: 'string',
        description: 'Shell command Porter should execute to start this project.'
      },
      stopCommand: {
        type: 'string',
        description: 'Shell command Porter should execute to stop this project.'
      }
    },
    required: ['folder', 'startCommand', 'stopCommand'],
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
          stopCommand: { type: 'string' }
        },
        required: ['id', 'name', 'folder', 'startCommand', 'stopCommand'],
        additionalProperties: false
      }
    },
    required: ['action', 'project'],
    additionalProperties: false
  },
  annotations: {
    title: 'Set up a Porter project',
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
          title: 'Porter',
          version: SERVER_VERSION,
          description: 'Adds local projects to the Porter VS Code extension.'
        },
        instructions: 'Use porter_setup_project when the user asks to save a local project in Porter. Provide the absolute folder path and the exact start and stop commands.'
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
    toolError(message.id, 'Porter storage is unavailable. Restart VS Code and try again.');
    return;
  }

  try {
    const argumentsValue = message.params?.arguments;
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      throw new Error('arguments must be an object.');
    }
    const allowedKeys = new Set(['folder', 'startCommand', 'stopCommand']);
    const unsupportedKeys = Object.keys(argumentsValue).filter((key) => !allowedKeys.has(key));
    if (unsupportedKeys.length) {
      throw new Error(`unsupported argument: ${unsupportedKeys.join(', ')}`);
    }

    const saved = upsertProject(PROJECTS_FILE, argumentsValue);
    const structuredContent = {
      action: saved.action,
      project: saved.project
    };
    result(message.id, {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false
    });
  } catch (toolFailure) {
    toolError(message.id, `Could not set up the Porter project: ${toolFailure.message}`);
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
