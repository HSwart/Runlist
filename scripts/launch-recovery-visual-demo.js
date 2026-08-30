#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-recovery-visual-')));
  const workspacePath = path.join(root, 'workspace');
  const userDataPath = path.join(root, 'user-data');
  const extensionsPath = path.join(root, 'extensions');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(extensionsPath, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'User', 'settings.json'), JSON.stringify({
    'files.simpleDialog.enable': true,
    'workbench.startupEditor': 'none',
    'terminal.integrated.tabs.enabled': true,
    'workbench.colorTheme': 'Default Dark Modern'
  }, null, 2));
  fs.writeFileSync(path.join(root, 'demo-root.txt'), `${root}\n`, 'utf8');

  const vscodeExecutable = path.join(
    extensionDevelopmentPath,
    '.vscode-test',
    'vscode-linux-x64-1.135.0',
    'code'
  );
  if (!fs.existsSync(vscodeExecutable)) {
    throw new Error(`VS Code executable not found at ${vscodeExecutable}. Run npm test once to download it.`);
  }

  process.stdout.write(`Recovery visual demo root: ${root}\n`);
  process.stdout.write('Launching VS Code outside test mode so confirmation modals work.\n');

  const child = spawn(vscodeExecutable, [
    workspacePath,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--user-data-dir=${userDataPath}`,
    `--extensions-dir=${extensionsPath}`,
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--skip-welcome',
    '--no-sandbox',
    '--disable-gpu-sandbox'
  ], {
    env: {
      ...process.env,
      RUNLIST_RECOVERY_AUTO_SEED: '1',
      RUNLIST_RECOVERY_WALKTHROUGH_ROOT: root
    },
    stdio: 'inherit'
  });

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`VS Code exited with code ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
