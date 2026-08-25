const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [rootPidPath, childPidPath, runCountPath, exitSignalPath] = process.argv.slice(2);
if (!rootPidPath || !childPidPath || !runCountPath || !exitSignalPath) {
  throw new Error('Expected root, child, run-count, and exit-signal paths.');
}

const runCount = Number(fs.existsSync(runCountPath)
  ? fs.readFileSync(runCountPath, 'utf8')
  : 0) + 1;
fs.writeFileSync(runCountPath, String(runCount));
fs.writeFileSync(rootPidPath, String(process.pid));
const child = spawn(process.execPath, [path.join(__dirname, 'idle.js'), childPidPath], {
  detached: process.platform === 'win32',
  stdio: 'ignore',
  windowsHide: true
});
if (process.platform === 'win32') {
  child.unref();
}

if (runCount === 1) {
  const exitPoll = setInterval(() => {
    if (!fs.existsSync(exitSignalPath)) {
      return;
    }
    clearInterval(exitPoll);
    process.exit(0);
  }, 25);
} else {
  setInterval(() => {}, 1000);
}
