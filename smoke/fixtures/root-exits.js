const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [rootPidPath, childPidPath, runCountPath] = process.argv.slice(2);
if (!rootPidPath || !childPidPath || !runCountPath) {
  throw new Error('Expected root, child, and run-count paths.');
}

const runCount = Number(fs.existsSync(runCountPath)
  ? fs.readFileSync(runCountPath, 'utf8')
  : 0) + 1;
fs.writeFileSync(runCountPath, String(runCount));
fs.writeFileSync(rootPidPath, String(process.pid));
spawn(process.execPath, [path.join(__dirname, 'idle.js'), childPidPath], {
  stdio: 'ignore',
  windowsHide: true
});

if (runCount === 1) {
  setTimeout(() => process.exit(0), 1500);
} else {
  setInterval(() => {}, 1000);
}
