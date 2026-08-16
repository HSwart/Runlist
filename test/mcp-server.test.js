const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { MAX_DIAGNOSTIC_OUTPUT_CHARS, writeProjectDiagnostics } = require('../project-diagnostics');
const { ProcessOwnershipStore } = require('../project-process');

test('serves the setup tool over MCP stdio', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-mcp-'));
  const projectFolder = path.join(temporaryRoot, 'agent-app');
  const projectsFile = path.join(temporaryRoot, 'projects.json');
  const installedRoot = path.join(temporaryRoot, 'installed-bridge');
  const installedMcpRoot = path.join(installedRoot, 'mcp');
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(installedMcpRoot, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'mcp', 'server.js'),
    path.join(installedMcpRoot, 'server.js')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'project-store.js'),
    path.join(installedRoot, 'project-store.js')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'external-url.js'),
    path.join(installedRoot, 'external-url.js')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'project-process.js'),
    path.join(installedRoot, 'project-process.js')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'project-output.js'),
    path.join(installedRoot, 'project-output.js')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'project-diagnostics.js'),
    path.join(installedRoot, 'project-diagnostics.js')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'package.json'),
    path.join(installedRoot, 'package.json')
  );
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
  assert.equal(listed.result.tools.length, 2);
  assert.equal(listed.result.tools[0].name, 'runlist_setup_project');
  assert.match(listed.result.tools[0].description, /custom name/i);
  assert.match(listed.result.tools[0].description, /reviews and approves/i);
  assert.match(listed.result.tools[0].inputSchema.properties.name.description, /friendly project name/i);
  assert.match(listed.result.tools[0].inputSchema.properties.services.items.properties.url.description, /optional.*HTTP or HTTPS/i);
  assert.ok(listed.result.tools[0].inputSchema.required.includes('services'));
  assert.equal(listed.result.tools[0].inputSchema.required.includes('stopCommand'), false);
  assert.match(listed.result.tools[0].inputSchema.properties.stopCommand.description, /optional.*custom/i);
  assert.match(listed.result.tools[0].inputSchema.properties.stopCommand.description, /advanced/i);
  assert.equal(listed.result.tools[1].name, 'runlist_get_project_diagnostics');
  assert.equal(listed.result.tools[1].annotations.readOnlyHint, true);
  assert.equal(listed.result.tools[1].annotations.openWorldHint, false);
  assert.deepEqual(listed.result.tools[1].inputSchema.required, ['projectId']);

  const called = await request('tools/call', {
    name: 'runlist_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [
        { name: 'web', port: 3000, url: 'https://app.local/dashboard' },
        { name: 'api', port: 4000 }
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
    { name: 'web', port: 3000, url: 'https://app.local/dashboard' },
    { name: 'api', port: 4000 }
  ]);
  const storedProjects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.equal(storedProjects.length, 1);
  assert.equal(storedProjects[0].reviewRequired, true);

  const reviewBlockedDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: storedProjects[0].id }
  });
  assert.equal(reviewBlockedDiagnostics.result.isError, true);
  assert.match(reviewBlockedDiagnostics.result.content[0].text, /Review and approve/i);

  storedProjects[0].reviewRequired = false;
  fs.writeFileSync(projectsFile, `${JSON.stringify(storedProjects, null, 2)}\n`);

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

  storedProjects[0].startCommand = 'API_KEY=command-secret npm run dev';
  fs.writeFileSync(projectsFile, `${JSON.stringify(storedProjects, null, 2)}\n`);
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
    failedAt: 1234
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
  assert.equal(diagnostics.result.structuredContent.outputTruncated, true);
  assert.ok(diagnostics.result.structuredContent.retainedOutput.length <= MAX_DIAGNOSTIC_OUTPUT_CHARS);
  assert.doesNotMatch(JSON.stringify(diagnostics.result), /command-secret|output-secret|summary-secret|\u001b/);
  assert.match(diagnostics.result.structuredContent.project.startCommand, /\[redacted\]/);
  assert.match(diagnostics.result.structuredContent.failureSummary.message, /\[redacted\]/);

  writeProjectDiagnostics(projectsFile, storedProjects[0].id, {
    lifecycleState: 'stopped',
    signal: 'SIGTERM',
    summary: { message: 'spawn failed' },
    output: ''
  });
  const noOutputDiagnostics = await request('tools/call', {
    name: 'runlist_get_project_diagnostics',
    arguments: { projectId: storedProjects[0].id }
  });
  assert.equal(noOutputDiagnostics.result.isError, false);
  assert.equal(noOutputDiagnostics.result.structuredContent.retainedOutput, '');
  assert.equal(noOutputDiagnostics.result.structuredContent.signal, 'SIGTERM');

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
