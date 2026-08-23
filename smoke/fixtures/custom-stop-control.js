const fs = require('fs');

const [modePath, targetPidPath, commandPidPath] = process.argv.slice(2);
if (!modePath || !targetPidPath) {
  throw new Error('Expected mode and target PID paths.');
}
if (commandPidPath) {
  fs.writeFileSync(commandPidPath, String(process.pid));
}

const mode = fs.readFileSync(modePath, 'utf8').trim();
if (mode === 'fail') {
  process.stderr.write('controlled custom stop failure\n');
  process.exitCode = 7;
} else if (mode === 'noop') {
  process.stdout.write('custom stop exited without stopping the target\n');
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'stop') {
  const pid = Number(fs.readFileSync(targetPidPath, 'utf8'));
  process.kill(pid);
} else {
  throw new Error(`Unknown custom stop mode: ${mode}`);
}
