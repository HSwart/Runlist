const { spawn } = require('child_process');

const command = process.argv[2];
if (typeof command !== 'string' || !command || command.includes('\0')) {
  process.stderr.write('Runlist could not launch an invalid start command.\n');
  process.exitCode = 1;
} else {
  let child;
  try {
    child = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    });
  } catch (error) {
    process.stderr.write(`Runlist could not launch the start command: ${error.message}\n`);
    process.exitCode = 1;
  }

  child?.once('error', (error) => {
    process.stderr.write(`Runlist could not launch the start command: ${error.message}\n`);
    process.exitCode = 1;
  });
  child?.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
}
