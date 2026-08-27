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

if (typeof command !== 'string' || !command || command.includes('\0')) {
  process.stderr.write('Runlist could not launch an invalid start command.\n');
  complete({ code: 1 });
} else {
  let child;
  try {
    child = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      // Keep stdin open so the named Terminal PTY can type into the app.
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true
    });
  } catch (error) {
    process.stderr.write(`Runlist could not launch the start command: ${error.message}\n`);
    complete({ code: 1 });
  }

  if (child?.pid && typeof process.send === 'function') {
    try {
      process.send({ type: 'runlistCommandStarted', pid: child.pid });
    } catch {
      // Identity capture can continue without the command PID hint.
    }
  }

  if (child?.stdin && process.stdin) {
    process.stdin.on('data', (chunk) => {
      try {
        child.stdin.write(chunk);
      } catch {
        // Ignore stdin races after the command exits.
      }
    });
    process.stdin.on('end', () => {
      try {
        child.stdin.end();
      } catch {
        // Ignore.
      }
    });
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
