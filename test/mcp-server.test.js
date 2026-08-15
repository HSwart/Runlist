const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('serves the setup tool over MCP stdio', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-mcp-'));
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
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const server = spawn(process.execPath, [path.join(installedMcpRoot, 'server.js')], {
    env: { ...process.env, SWITCHBOARD_PROJECTS_FILE: projectsFile },
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
    clientInfo: { name: 'switchboard-test', version: '1.0.0' }
  });
  assert.equal(initialized.result.serverInfo.name, 'switchboard-mcp-server');
  assert.match(initialized.result.instructions, /custom project name/i);

  const listed = await request('tools/list');
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, 'switchboard_setup_project');
  assert.match(listed.result.tools[0].description, /custom name/i);
  assert.match(listed.result.tools[0].description, /reviews and approves/i);
  assert.match(listed.result.tools[0].inputSchema.properties.name.description, /friendly project name/i);
  assert.ok(listed.result.tools[0].inputSchema.required.includes('services'));
  assert.equal(listed.result.tools[0].inputSchema.required.includes('stopCommand'), false);
  assert.match(listed.result.tools[0].inputSchema.properties.stopCommand.description, /optional custom/i);

  const called = await request('tools/call', {
    name: 'switchboard_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev',
      services: [
        { name: 'web', port: 3000 },
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
    { name: 'web', port: 3000 },
    { name: 'api', port: 4000 }
  ]);
  const storedProjects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.equal(storedProjects.length, 1);
  assert.equal(storedProjects[0].reviewRequired, true);

  storedProjects[0].reviewRequired = false;
  fs.writeFileSync(projectsFile, `${JSON.stringify(storedProjects, null, 2)}\n`);
  const updated = await request('tools/call', {
    name: 'switchboard_setup_project',
    arguments: {
      name: 'Agent app',
      folder: projectFolder,
      startCommand: 'npm run dev -- --host',
      stopCommand: 'npm stop',
      services: [
        { name: 'web', port: 3000 },
        { name: 'api', port: 4000 }
      ]
    }
  });
  assert.equal(updated.result.structuredContent.action, 'updated');
  assert.equal(updated.result.structuredContent.project.stopCommand, 'npm stop');
  assert.equal(updated.result.structuredContent.project.reviewRequired, true);

  const invalid = await request('tools/call', {
    name: 'switchboard_setup_project',
    arguments: {
      folder: 'relative/path',
      startCommand: 'npm run dev',
      services: [{ name: 'web', port: 3000 }]
    }
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /absolute path/);

  const missingServices = await request('tools/call', {
    name: 'switchboard_setup_project',
    arguments: {
      folder: projectFolder,
      startCommand: 'npm run dev'
    }
  });
  assert.equal(missingServices.result.isError, true);
  assert.match(missingServices.result.content[0].text, /at least one service and port/);

  const emptyServices = await request('tools/call', {
    name: 'switchboard_setup_project',
    arguments: {
      folder: projectFolder,
      startCommand: 'npm run dev',
      stopCommand: 'pkill -f vite',
      services: []
    }
  });
  assert.equal(emptyServices.result.isError, true);
  assert.match(emptyServices.result.content[0].text, /at least one service and port/);
});
