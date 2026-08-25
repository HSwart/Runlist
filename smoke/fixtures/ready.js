const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const [smokeRoot, portText, childPidPath, grandchildPidPath, delayText, rootPidPath] = process.argv.slice(2);
const port = Number(portText?.startsWith('env:')
  ? process.env[portText.slice('env:'.length)]
  : portText);
const delayMs = delayText ? Number(delayText) : 0;
if (!smokeRoot || !Number.isInteger(port) || !Number.isInteger(delayMs) || delayMs < 0) {
  throw new Error('Expected a smoke root and port.');
}

if (childPidPath) {
  spawn(process.execPath, [
    path.join(__dirname, 'idle.js'),
    childPidPath,
    ...(grandchildPidPath ? [grandchildPidPath] : [])
  ], {
    stdio: 'ignore',
    windowsHide: true
  });
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('ready');
});

setTimeout(() => {
  server.listen(port, () => {
    fs.writeFileSync(rootPidPath || path.join(smokeRoot, 'ready.pid'), String(process.pid));
    process.stdout.write(`ready on ${port}\n`);
  });
}, delayMs);
