const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [pidPath, childPidPath] = process.argv.slice(2);
if (!pidPath) {
  throw new Error('Expected a fixture pid path.');
}

fs.writeFileSync(pidPath, String(process.pid));
if (childPidPath) {
  spawn(process.execPath, [path.join(__dirname, 'idle.js'), childPidPath], {
    stdio: 'ignore',
    windowsHide: true
  });
}

setInterval(() => {}, 1000);
