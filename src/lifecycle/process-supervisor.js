const { spawn } = require('child_process');

const command = process.argv[2];
const identityGated = typeof process.send === 'function';
let identityReleased = !identityGated;
let commandOutcome;
let finished = false;

function releaseIdentityHold() {
  identityReleased = true;
  if (process.connected) {
    process.disconnect();
  }
  finish();
}

function complete(outcome) {
  if (!commandOutcome) {
    commandOutcome = outcome;
  }
  finish();
}

function finish() {
  if (finished || !identityReleased || !commandOutcome) {
    return;
  }
  finished = true;
  if (commandOutcome.signal) {
    process.kill(process.pid, commandOutcome.signal);
    return;
  }
  process.exitCode = commandOutcome.code;
}

if (identityGated) {
  process.on('message', (message) => {
    if (message?.type === 'runlistIdentityCaptured') {
      releaseIdentityHold();
    }
  });
  process.once('disconnect', releaseIdentityHold);
}

const argvMode = process.argv[2] === '--';
const file = argvMode ? process.argv[3] : command;
const args = argvMode ? process.argv.slice(4) : undefined;
const invalidArgv = argvMode && (
  typeof file !== 'string'
  || !file
  || file.includes('\0')
  || !Array.isArray(args)
  || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
);
const invalidCommand = !argvMode && (typeof command !== 'string' || !command || command.includes('\0'));

if (invalidArgv || invalidCommand) {
  process.stderr.write('Runlist could not launch an invalid start command.\n');
  complete({ code: 1 });
} else {
  let child;
  try {
    child = argvMode
      ? spawn(file, args, {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true
      })
      : spawn(command, {
        cwd: process.cwd(),
        env: process.env,
        shell: true,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true
      });
  } catch (error) {
    process.stderr.write(`Runlist could not launch the start command: ${error.message}\n`);
    complete({ code: 1 });
  }

  child?.once('error', (error) => {
    process.stderr.write(`Runlist could not launch the start command: ${error.message}\n`);
    complete({ code: 1 });
  });
  child?.once('exit', (code, signal) => {
    complete({
      code: Number.isInteger(code) ? code : 1,
      signal
    });
  });
}
