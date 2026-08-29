const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { upsertProject } = require('../src/projects/project-store');
const { markSmokeProcessExited, registerSmokeProcess } = require('./run');

async function run() {
  const smokeRoot = requiredEnvironment('RUNLIST_SMOKE_ROOT');
  const nodePath = requiredEnvironment('RUNLIST_SMOKE_NODE');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspacePath, 'The isolated smoke workspace did not open.');

  const extension = vscode.extensions.getExtension('hankoswart.runlist');
  assert.ok(extension, 'The Runlist development extension was not installed.');
  const api = await extension.activate();
  assert.ok(api?.provider, 'The extension did not expose its guarded smoke API.');

  const idlePath = path.join(extension.extensionPath, 'smoke', 'fixtures', 'idle.js');

  const missingRequired = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env missing required',
    folderName: 'env-missing-required',
    config: {
      requiredEnvKeys: ['API_KEY']
    },
    files: {}
  });
  const missingRequiredPidPath = path.join(smokeRoot, 'env-missing-required.pid');
  assert.equal(
    await api.provider.startProject(missingRequired.id),
    true,
    'Start should continue when a required key is missing, with a warning.'
  );
  await waitFor(() => fs.existsSync(missingRequiredPidPath), 'Missing required fixture did not start.');
  assertEnvWarning(
    api.provider.projectOutputs.get(missingRequired.id) || '',
    /Required variables are missing \(Start continues\): API_KEY/
  );
  assert.doesNotMatch(
    api.provider.projectOutputs.get(missingRequired.id) || '',
    /Required environment variables are not ready/
  );
  await stopIdleFixture(api, missingRequired, missingRequiredPidPath, smokeRoot);

  const emptyRequired = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env empty required',
    folderName: 'env-empty-required',
    config: {
      envFile: '.env.local',
      requiredEnvKeys: ['API_KEY']
    },
    files: {
      '.env.local': 'API_KEY=\n'
    }
  });
  const emptyRequiredPidPath = path.join(smokeRoot, 'env-empty-required.pid');
  assert.equal(
    await api.provider.startProject(emptyRequired.id),
    true,
    'Start should continue when a required key is empty in the attached env file.'
  );
  await waitFor(() => fs.existsSync(emptyRequiredPidPath), 'Empty required fixture did not start.');
  assertEnvWarning(
    api.provider.projectOutputs.get(emptyRequired.id) || '',
    /Required variables are empty in \.env\.local \(Start continues\): API_KEY/
  );
  await stopIdleFixture(api, emptyRequired, emptyRequiredPidPath, smokeRoot);

  const advisoryEmpty = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env advisory empty',
    folderName: 'env-advisory-empty',
    config: {},
    files: {
      '.env.local': 'ADVISORY_TOKEN=\n'
    }
  });
  const advisoryPidPath = path.join(smokeRoot, 'env-advisory-empty.pid');
  assert.equal(
    await api.provider.startProject(advisoryEmpty.id),
    true,
    'Start should continue when only advisory env keys are empty.'
  );
  await waitFor(() => fs.existsSync(advisoryPidPath), 'Advisory empty fixture did not start.');
  const advisoryOutput = api.provider.projectOutputs.get(advisoryEmpty.id) || '';
  assert.match(advisoryOutput, /Empty variables in \.env\.local \(Start continues\): ADVISORY_TOKEN/);
  assert.match(advisoryOutput, /Found \.env\.local\. Attach it as this launch profile/);
  await stopIdleFixture(api, advisoryEmpty, advisoryPidPath, smokeRoot);

  const azureFunctions = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env Azure Functions advisory',
    folderName: 'env-azure-functions',
    config: {},
    files: {
      'host.json': '{}\n',
      'local.settings.json': JSON.stringify({
        Values: {
          AzureWebJobsStorage: '',
          FUNCTIONS_WORKER_RUNTIME: 'python'
        }
      }, null, 2)
    }
  });
  const azurePidPath = path.join(smokeRoot, 'env-azure-functions.pid');
  assert.equal(
    await api.provider.startProject(azureFunctions.id),
    true,
    'Start should continue when Azure Functions settings contain only advisory empty values.'
  );
  await waitFor(() => fs.existsSync(azurePidPath), 'Azure Functions advisory fixture did not start.');
  const azureOutput = api.provider.projectOutputs.get(azureFunctions.id) || '';
  assert.match(
    azureOutput,
    /Empty variables in local\.settings\.json \(Start continues\): AzureWebJobsStorage/
  );
  await stopIdleFixture(api, azureFunctions, azurePidPath, smokeRoot);

  const exampleOnly = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env example advisory',
    folderName: 'env-example-advisory',
    config: {},
    files: {
      '.env.example': 'DATABASE_URL=postgres://example\n'
    }
  });
  const examplePidPath = path.join(smokeRoot, 'env-example-advisory.pid');
  assert.equal(
    await api.provider.startProject(exampleOnly.id),
    true,
    '.env.example placeholders must remain advisory-only.'
  );
  await waitFor(() => fs.existsSync(examplePidPath), 'Example advisory fixture did not start.');
  const exampleOutput = api.provider.projectOutputs.get(exampleOnly.id) || '';
  assert.match(exampleOutput, /Optional \.env\.example keys are unset \(Start continues\): DATABASE_URL/);
  assert.doesNotMatch(exampleOutput, /Required environment variables are not ready/);
  await stopIdleFixture(api, exampleOnly, examplePidPath, smokeRoot);

  const monorepoRoot = path.join(workspacePath, 'env-monorepo-root');
  fs.mkdirSync(monorepoRoot, { recursive: true });
  fs.writeFileSync(path.join(monorepoRoot, '.env.local'), 'ROOT_ONLY=\n');
  const monorepoApi = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env monorepo subfolder',
    folderName: path.join('env-monorepo-root', 'api'),
    config: {},
    files: {
      '.env.local': 'API_ONLY=\n'
    }
  });
  const monorepoPidPath = path.join(smokeRoot, 'env-monorepo-root-api.pid');
  assert.equal(await api.provider.startProject(monorepoApi.id), true);
  await waitFor(() => fs.existsSync(monorepoPidPath), 'Monorepo subfolder fixture did not start.');
  const monorepoOutput = api.provider.projectOutputs.get(monorepoApi.id) || '';
  assert.match(monorepoOutput, /Empty variables in \.env\.local \(Start continues\): API_ONLY/);
  assert.doesNotMatch(monorepoOutput, /ROOT_ONLY/);
  await stopIdleFixture(api, monorepoApi, monorepoPidPath, smokeRoot);

  const invalidSettings = await createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
    name: 'Env invalid settings json',
    folderName: 'env-invalid-settings',
    config: {},
    files: {
      'host.json': '{}\n',
      'local.settings.json': '{ not-json'
    }
  });
  const invalidPidPath = path.join(smokeRoot, 'env-invalid-settings.pid');
  assert.equal(
    await api.provider.startProject(invalidSettings.id),
    true,
    'Invalid local.settings.json must not crash Start.'
  );
  await waitFor(() => fs.existsSync(invalidPidPath), 'Invalid settings fixture did not start.');
  await stopIdleFixture(api, invalidSettings, invalidPidPath, smokeRoot);

  await api.provider.dispose();
  process.stdout.write('Env presence live smoke passed.\n');
}

async function createEnvProject(api, workspacePath, smokeRoot, nodePath, idlePath, {
  name,
  folderName,
  config,
  files
}) {
  const folder = path.join(workspacePath, folderName);
  fs.mkdirSync(folder, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(folder, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const pidPath = path.join(smokeRoot, `${folderName.replace(/[\\/]/g, '-')}.pid`);
  const project = upsertProject(api.projectsFile, {
    name,
    folder,
    startCommand: command(nodePath, idlePath, pidPath),
    ...config
  }, { reviewRequired: false }).project;
  api.provider.renderProjectList();
  return project;
}

function assertEnvWarning(output, pattern) {
  assert.match(output, pattern);
}

async function stopIdleFixture(api, project, pidPath, smokeRoot) {
  assert.equal(fs.existsSync(pidPath), true, `Idle fixture for ${project.name} did not write a pid file.`);
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  await api.provider.stopProject(project.id, project);
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    },
    `Idle fixture for ${project.name} did not exit after Stop.`,
    10000
  );
  try {
    const record = await registerSmokeProcess(smokeRoot, pid, {
      kind: 'env-presence-idle',
      terminateTree: true
    });
    await markSmokeProcessExited(smokeRoot, record);
  } catch {
    // Best-effort bookkeeping only.
  }
}

function command(...parts) {
  return parts.map((part) => `"${String(part).replaceAll('"', '\\"')}"`).join(' ');
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `Missing ${name} for env-presence smoke.`);
  return value;
}

function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        if (await predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(typeof message === 'function' ? message() : message));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

module.exports = { run };

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
