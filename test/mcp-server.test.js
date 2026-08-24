const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { MAX_DIAGNOSTIC_OUTPUT_CHARS, writeProjectDiagnostics } = require('../src/projects/project-diagnostics');
const { ProcessOwnershipStore } = require('../src/lifecycle/project-process');
const {
  clearProjectRepairProposal,
  projectConfigurationRevision,
  readProjectRepairProposal
} = require('../src/projects/project-repair');
const { readProjects, upsertProject } = require('../src/projects/project-store');
const {
  createRequestLineParser,
  MAX_JSON_RPC_REQUEST_BYTES
} = require('../mcp/server');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function paddedPingRequest(targetBytes, paddingCharacter = 'x', id = 1) {
  const build = (padding) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'ping',
    params: { padding }
  });
  let padding = '';
  while (Buffer.byteLength(build(`${padding}${paddingCharacter}`), 'utf8') <= targetBytes) {
    padding += paddingCharacter;
  }
  while (Buffer.byteLength(build(padding), 'utf8') < targetBytes) {
    padding += 'x';
  }
  assert.equal(Buffer.byteLength(build(padding), 'utf8'), targetBytes);
  return build(padding);
}

function startRawMcpServer(t) {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
    env: { ...process.env, RUNLIST_PROJECTS_FILE: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const messages = [];
  const waiters = [];
  const output = readline.createInterface({ input: server.stdout });
  output.on('line', (line) => {
    messages.push(JSON.parse(line));
    while (waiters.length && messages.length >= waiters[0].count) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timeout);
      waiter.resolve(messages.splice(0, waiter.count));
    }
  });
  t.after(() => {
    output.close();
    server.stdin.end();
    server.kill();
  });
  return {
    server,
    waitForMessages(count = 1) {
      return new Promise((resolve, reject) => {
        if (messages.length >= count) {
          resolve(messages.splice(0, count));
          return;
        }
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for ${count} MCP responses.`));
        }, 3000);
        waiters.push({ count, reject, resolve, timeout });
      });
    }
  };
}

test('accepts MCP requests at and below the UTF-8 byte limit', async (t) => {
  const { server, waitForMessages } = startRawMcpServer(t);
  for (const [targetBytes, paddingCharacter, id] of [
    [MAX_JSON_RPC_REQUEST_BYTES - 1, 'x', 1],
    [MAX_JSON_RPC_REQUEST_BYTES, 'x', 2],
    [MAX_JSON_RPC_REQUEST_BYTES, 'é', 3]
  ]) {
    server.stdin.write(`${paddedPingRequest(targetBytes, paddingCharacter, id)}\n`);
    const [message] = await waitForMessages();
    assert.equal(message.id, id);
    assert.deepEqual(message.result, {});
  }
});

test('rejects an oversized MCP request and processes a later valid line', async (t) => {
  const { server, waitForMessages } = startRawMcpServer(t);
  const oversized = paddedPingRequest(MAX_JSON_RPC_REQUEST_BYTES + 1, 'x', 10);
  server.stdin.write(`${oversized}\n${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' })}\n`);

  const messages = await waitForMessages(2);
  assert.deepEqual(messages[0], {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Request line exceeds maximum size.' }
  });
  assert.equal(messages[1].id, 11);
  assert.deepEqual(messages[1].result, {});
});

test('measures multibyte MCP request lines in UTF-8 bytes', async (t) => {
  const { server, waitForMessages } = startRawMcpServer(t);
  const oversized = paddedPingRequest(MAX_JSON_RPC_REQUEST_BYTES + 1, 'é', 20);
  server.stdin.write(`${oversized}\n`);

  const [message] = await waitForMessages();
  assert.deepEqual(message, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Request line exceeds maximum size.' }
  });
});

test('frames an exact-limit request when CRLF is split across chunks', () => {
  const messages = [];
  const parser = createRequestLineParser({
    onLine(line) {
      messages.push(JSON.parse(line));
    },
    onOversized() {
      throw new Error('unexpected oversized request');
    }
  });
  const line = paddedPingRequest(MAX_JSON_RPC_REQUEST_BYTES, 'x', 30);

  parser.push(Buffer.from(`${line}\r`));
  parser.push(Buffer.from('\n'));

  assert.equal(messages[0].id, 30);
});

test('does not count a trailing CR delimiter at EOF against the limit', () => {
  const messages = [];
  const parser = createRequestLineParser({
    onLine(line) {
      messages.push(JSON.parse(line));
    },
    onOversized() {
      throw new Error('unexpected oversized request');
    }
  });
  const line = paddedPingRequest(MAX_JSON_RPC_REQUEST_BYTES, 'x', 31);

  parser.push(Buffer.from(`${line}\r`));
  parser.end();

  assert.equal(messages[0].id, 31);
});

test('frames a multibyte request split inside a codepoint', () => {
  const messages = [];
  const parser = createRequestLineParser({
    onLine(line) {
      messages.push(JSON.parse(line));
    },
    onOversized() {
      throw new Error('unexpected oversized request');
    }
  });
  const line = Buffer.from(`${paddedPingRequest(MAX_JSON_RPC_REQUEST_BYTES, 'é', 32)}\n`);
  const splitAt = line.indexOf(Buffer.from('é')) + 1;

  parser.push(line.subarray(0, splitAt));
  parser.push(line.subarray(splitAt));

  assert.equal(messages[0].id, 32);
});

test('frames a valid final request at EOF without a newline', () => {
  const messages = [];
  const parser = createRequestLineParser({
    onLine(line) {
      messages.push(JSON.parse(line));
    },
    onOversized() {
      throw new Error('unexpected oversized request');
    }
  });

  parser.push(Buffer.from(paddedPingRequest(MAX_JSON_RPC_REQUEST_BYTES - 1, 'x', 33)));
  parser.end();

  assert.equal(messages[0].id, 33);
});

test('serves the setup tool over MCP stdio', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-mcp-'));
  const projectFolder = path.join(temporaryRoot, 'agent-app');
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  const installedRoot = path.join(temporaryRoot, 'installed-bridge');
  const installedMcpRoot = path.join(installedRoot, 'mcp');
  const webPort = await availablePort();
  const apiPort = await availablePort();
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(installedMcpRoot, { recursive: true });
  const bridgeFiles = [
    'mcp/server.js',
    'src/lifecycle/atomic-json-record.js',
    'src/lifecycle/process-identity.js',
    'src/lifecycle/process-lock.js',
    'src/lifecycle/process-metrics.js',
    'src/lifecycle/project-process.js',
    'src/ports/service-port-overrides.js',
    'src/projects/launch-profile.js',
    'src/projects/project-output.js',
    'src/projects/project-diagnostics.js',
    'src/projects/project-repair.js',
    'src/projects/project-store.js',
    'src/projects/project-tags.js',
    'src/services/external-url.js',
    'package.json'
  ];
  for (const relativePath of bridgeFiles) {
    const sourcePath = path.join(__dirname, '..', ...relativePath.split('/'));
    const targetPath = path.join(installedRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const server = spawn(process.execPath, [path.join(installedMcpRoot, 'server.js')], {
    env: { ...process.env, RUNLIST_PROJECTS_FILE: projectsFile },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => server.kill());

  const pending = new Map();
  const output = readline.createInterface({ input: server.stdout });
  output.on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  let requestId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 3000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'runlist-test', version: '1.0.0' }
  });
  assert.equal(initialized.result.serverInfo.name, 'runlist-mcp-server');
  assert.equal(initialized.result.serverInfo.version, require('../package.json').version);
  assert.match(initialized.result.instructions, /custom project name/i);

  const listed = await request('tools/list');
  assert.equal(listed.result.tools.length, 3);
  assert.equal(listed.result.tools[0].name, 'runlist_setup_project');
  assert.match(listed.result.tools[0].description, /custom name/i);
  assert.match(listed.result.tools[0].description, /reviews and approves/i);
  assert.match(listed.result.tools[0].inputSchema.properties.name.description, /friendly project name/i);
  assert.match(listed.result.tools[0].inputSchema.properties.services.items.properties.url.description, /optional.*HTTP or HTTPS/i);
  assert.equal(
    Object.hasOwn(listed.result.tools[0].inputSchema.properties.services.items.properties, 'portVariable'),
    false
  );
  assert.ok(listed.result.tools[0].inputSchema.required.includes('services'));
  assert.equal(listed.result.tools[0].inputSchema.required.includes('stopCommand'), false);
  assert.match(listed.result.tools[0].inputSchema.properties.stopCommand.description, /optional.*custom/i);
  assert.match(listed.result.tools[0].inputSchema.properties.stopCommand.description, /advanced/i);
  assert.equal(listed.result.tools[1].name, 'runlist_get_project_diagnostics');
  assert.ok(listed.result.tools[1].outputSchema.properties.project.properties.launchProfile);
  assert.ok(listed.result.tools[1].outputSchema.properties.project.required.includes('launchProfile'));
  assert.equal(listed.result.tools[1].annotations.readOnlyHint, true);
  assert.equal(listed.result.tools[1].annotations.openWorldHint, false);
  assert.deepEqual(listed.result.tools[1].inputSchema.required, ['projectId']);
  assert.equal(listed.result.tools[1].inputSchema.properties.projectId.maxLength, 256);
  assert.equal(listed.result.tools[2].name, 'runlist_propose_project_repair');
  assert.equal(listed.result.tools[2].annotations.readOnlyHint, false);
  assert.equal(listed.result.tools[2].annotations.openWorldHint, false);
  assert.deepEqual(
    listed.result.tools[2].inputSchema.required,
    ['projectId', 'projectRevision', 'failedAt', 'proposal']
  );
  assert.equal(listed.result.tools[2].inputSchema.properties.projectId.maxLength, 256);
  assert.equal(
    Object.hasOwn(
      listed.result.tools[2].inputSchema.properties.proposal.properties.services.items.properties,
      'portVariable'
    ),
    false
  );

  const rejectedLegacyServiceField = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [{ name: 'web', port: 3000, portVariable: 'PORT' }]
    }
  });
  assert.equal(rejectedLegacyServiceField.result.isError, true);
  assert.match(rejectedLegacyServiceField.result.content[0].text, /unsupported services\[0\] field/i);
  assert.deepEqual(readProjects(projectsFile), []);

  const called = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [
        { name: 'web', port: webPort, url: 'https://app.local/dashboard' },
        { name: 'api', port: apiPort }
      ]
    }
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.action, 'created');
  assert.equal(called.result.structuredContent.project.name, 'Agent app');
  assert.equal(called.result.structuredContent.project.reviewRequired, true);
  assert.equal(Object.hasOwn(called.result.structuredContent.project, 'stopCommand'), false);
  assert.match(called.result.content[0].text, /must review and approve/i);
  assert.deepEqual(called.result.structuredContent.project.services, [
    { name: 'web', port: webPort, url: 'https://app.local/dashboard' },
    { name: 'api', port: apiPort }
  ]);
  let storedProjects = readProjects(projectsFile);
  assert.equal(storedProjects.length, 1);
  assert.equal(storedProjects[0].reviewRequired, true);

  upsertProject(projectsFile, {
    ...storedProjects[0],
    pinned: true,
    tags: ['Backend'],
    launchProfiles: [{
      id: 'worker',
      name: 'Worker',
      startCommand: 'npm run worker',
      services: []
    }]
  }, { reviewRequired: true });
  const setupUpdated = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [{ name: 'web', port: webPort }]
    }
  });
  assert.equal(
    setupUpdated.result.isError,
    false,
    JSON.stringify(setupUpdated.result)
  );
  assert.equal(setupUpdated.result.structuredContent.action, 'updated');
  assert.equal(Object.hasOwn(setupUpdated.result.structuredContent.project, 'tags'), false);
  assert.equal(Object.hasOwn(setupUpdated.result.structuredContent.project, 'pinned'), false);
  assert.equal(Object.hasOwn(setupUpdated.result.structuredContent.project, 'launchProfiles'), false);
  storedProjects = readProjects(projectsFile);
  assert.deepEqual(storedProjects[0].tags, ['Backend']);
  assert.equal(storedProjects[0].pinned, true);
  assert.equal(storedProjects[0].launchProfiles[0].id, 'worker');

  const reviewBlockedDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: storedProjects[0].id }
  });
  assert.equal(reviewBlockedDiagnostics.result.isError, true);
  assert.match(reviewBlockedDiagnostics.result.content[0].text, /Review and approve/i);

  upsertProject(projectsFile, storedProjects[0], { reviewRequired: false });
  storedProjects = readProjects(projectsFile);

  const missingDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: storedProjects[0].id }
  });
  assert.equal(missingDiagnostics.result.isError, true);
  assert.match(missingDiagnostics.result.content[0].text, /does not have a retained failed start/i);

  const unknownDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: 'unknown-project' }
  });
  assert.equal(unknownDiagnostics.result.isError, true);
  assert.match(unknownDiagnostics.result.content[0].text, /was not found/i);

  const longUnknownDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: 'x'.repeat(256) }
  });
  assert.equal(longUnknownDiagnostics.result.isError, true);
  assert.match(longUnknownDiagnostics.result.content[0].text, /was not found/i);

  upsertProject(projectsFile, {
    ...storedProjects[0],
    startCommand: 'API_KEY=command-secret npm run dev'
  }, { reviewRequired: false });
  storedProjects = readProjects(projectsFile);
  const diagnosticRevision = projectConfigurationRevision(storedProjects[0]);
  writeProjectDiagnostics(projectsFile, storedProjects[0].id, {
    platform: 'win32',
    lifecycleState: 'stopped',
    exitCode: 1,
    summary: {
      title: 'Start failed',
      message: 'Authorization: summary-secret',
      outcome: 'Exited with code 1'
    },
    output: `\u001b[31mAPI_KEY=output-secret\u001b[0m\n${'x'.repeat(MAX_DIAGNOSTIC_OUTPUT_CHARS + 100)}`,
    failedAt: 1234,
    projectRevision: diagnosticRevision
  });
  const diagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: storedProjects[0].id }
  });
  assert.equal(diagnostics.result.isError, false);
  assert.equal(diagnostics.result.structuredContent.project.id, storedProjects[0].id);
  assert.equal(diagnostics.result.structuredContent.platform, 'win32');
  assert.equal(diagnostics.result.structuredContent.observedLifecycleState, 'stopped');
  assert.equal(diagnostics.result.structuredContent.exitCode, 1);
  assert.equal(diagnostics.result.structuredContent.signal, null);
  assert.equal(diagnostics.result.structuredContent.projectRevision, diagnosticRevision);
  assert.equal(diagnostics.result.structuredContent.outputTruncated, true);
  assert.ok(diagnostics.result.structuredContent.retainedOutput.length <= MAX_DIAGNOSTIC_OUTPUT_CHARS);
  assert.doesNotMatch(JSON.stringify(diagnostics.result), /command-secret|output-secret|summary-secret|\u001b/);
  assert.match(diagnostics.result.structuredContent.project.startCommand, /\[redacted\]/);
  assert.match(diagnostics.result.structuredContent.failureSummary.message, /\[redacted\]/);

  const beforeProposal = fs.readFileSync(projectsFile, 'utf8');
  const proposed = await request('tools/call', {
    name: 'runlist_propose_project_repair',
    arguments: {
      projectId: storedProjects[0].id,
      projectRevision: diagnosticRevision,
      failedAt: 1234,
      proposal: { startCommand: 'npm run dev -- --host' }
    }
  });
  assert.equal(proposed.result.isError, false);
  assert.equal(proposed.result.structuredContent.projectId, storedProjects[0].id);
  assert.equal(proposed.result.structuredContent.projectRevision, diagnosticRevision);
  assert.match(proposed.result.structuredContent.proposalId, /^[0-9a-f-]{36}$/);
  assert.match(proposed.result.content[0].text, /review.*Runlist/i);
  assert.equal(fs.readFileSync(projectsFile, 'utf8'), beforeProposal);
  assert.equal(
    readProjectRepairProposal(projectsFile, storedProjects[0].id).proposedProject.startCommand,
    'npm run dev -- --host'
  );
  clearProjectRepairProposal(projectsFile, storedProjects[0].id);

  const malformedProposal = await request('tools/call', {
    name: 'runlist_propose_project_repair',
    arguments: {
      projectId: storedProjects[0].id,
      projectRevision: diagnosticRevision,
      failedAt: 1234,
      proposal: { unsupported: true }
    }
  });
  assert.equal(malformedProposal.result.isError, true);
  assert.match(malformedProposal.result.content[0].text, /unsupported proposal field/i);

  writeProjectDiagnostics(projectsFile, storedProjects[0].id, {
    lifecycleState: 'stopped',
    signal: 'SIGTERM',
    summary: { message: 'spawn failed' },
    output: '',
    projectRevision: diagnosticRevision
  });
  const noOutputDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: storedProjects[0].id }
  });
  assert.equal(noOutputDiagnostics.result.isError, false);
  assert.equal(noOutputDiagnostics.result.structuredContent.retainedOutput, '');
  assert.equal(noOutputDiagnostics.result.structuredContent.signal, 'SIGTERM');

  const profiledProject = upsertProject(projectsFile, {
    ...storedProjects[0],
    launchProfiles: [{
      id: 'tests',
      name: 'Tests',
      startCommand: 'npm run test:profile',
      services: [{ name: 'test-api', port: 4311 }]
    }],
    selectedLaunchProfileId: 'tests'
  }, { reviewRequired: false }).project;
  const profiledRevision = projectConfigurationRevision(profiledProject);
  writeProjectDiagnostics(projectsFile, profiledProject.id, {
    lifecycleState: 'stopped',
    summary: { message: 'profile failed' },
    output: '',
    failedAt: 5678,
    projectRevision: profiledRevision,
    launchProfileId: 'tests'
  });
  const profileDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: profiledProject.id }
  });
  assert.equal(profileDiagnostics.result.isError, false);
  assert.deepEqual(profileDiagnostics.result.structuredContent.project.launchProfile, {
    id: 'tests',
    name: 'Tests'
  });
  assert.equal(
    profileDiagnostics.result.structuredContent.project.startCommand,
    'npm run test:profile'
  );
  assert.deepEqual(profileDiagnostics.result.structuredContent.project.services, [{
    name: 'test-api', port: 4311
  }]);

  const profileRepair = await request('tools/call', {
    name: 'runlist_propose_project_repair',
    arguments: {
      projectId: profiledProject.id,
      projectRevision: profiledRevision,
      failedAt: 5678,
      proposal: { startCommand: 'npm run test:fixed' }
    }
  });
  assert.equal(profileRepair.result.isError, false);
  const proposedProfile = readProjectRepairProposal(projectsFile, profiledProject.id)
    .proposedProject.launchProfiles.find((profile) => profile.id === 'tests');
  assert.equal(proposedProfile.startCommand, 'npm run test:fixed');
  assert.equal(
    readProjectRepairProposal(projectsFile, profiledProject.id).proposedProject.startCommand,
    profiledProject.startCommand
  );
  clearProjectRepairProposal(projectsFile, profiledProject.id);

  const processOwnership = new ProcessOwnershipStore(
    path.join(temporaryRoot, 'process-ownership')
  );
  assert.equal(processOwnership.reserve(storedProjects[0].id), undefined);
  processOwnership.setProcess(storedProjects[0].id, process.pid);
  const blockedUpdate = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev -- --host',
      services: [{ name: 'web', port: 3000 }]
    }
  });
  assert.equal(blockedUpdate.result.isError, true);
  assert.match(blockedUpdate.result.content[0].text, /Stop Agent app before.*update/i);
  processOwnership.release(storedProjects[0].id);

  const updated = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev -- --host',
      stopCommand: 'docker compose down',
      services: [
        { name: 'web', port: 3000 },
        { name: 'api', port: 4000 }
      ]
    }
  });
  assert.equal(updated.result.structuredContent.action, 'updated');
  assert.equal(updated.result.structuredContent.project.reviewRequired, true);
  assert.equal(updated.result.structuredContent.project.stopCommand, 'docker compose down');

  const invalid = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      folder: 'relative/path',
      startCommand: 'npm run dev',
      services: [{ name: 'web', port: 3000 }]
    }
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /absolute path/);

  const missingServices = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      folder: projectFolder,
      startCommand: 'npm run dev'
    }
  });
  assert.equal(missingServices.result.isError, true);
  assert.match(missingServices.result.content[0].text, /at least one service and port/);

  const emptyServices = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      folder: projectFolder,
      startCommand: 'npm run dev',
      stopCommand: 'pkill -f vite',
      services: []
    }
  });
  assert.equal(emptyServices.result.isError, true);
  assert.match(emptyServices.result.content[0].text, /at least one service and port/);

  const unsafeUrl = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      folder: projectFolder,
      startCommand: 'npm run dev',
      stopCommand: 'pkill -f vite',
      services: [{ name: 'web', port: 3000, url: 'javascript:alert(1)' }]
    }
  });
  assert.equal(unsafeUrl.result.isError, true);
  assert.match(unsafeUrl.result.content[0].text, /valid HTTP or HTTPS URL/);
});

test('keeps MCP port variables launch-only and rejects stale setup fields', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /Include a port variable/);
  assert.match(serverSource, /const serviceKeys = new Set\(\['name', 'port', 'url'\]\)/);
  assert.match(serverSource, /expectedProject: existingProject/);
  assert.match(serverSource, /expectProjectAbsent: true/);
});

test('does not probe review-required projects before approval', () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(extensionSource, /effectiveProjects\.map\(async \(project\) => \{[\s\S]*if \(project\.reviewRequired\) \{[\s\S]*return \[project\.id, 'stopped'/);
});
