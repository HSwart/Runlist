const fs = require('fs');
const http = require('http');
const path = require('path');

const [smokeRoot, portText] = process.argv.slice(2);
const port = Number(portText);
if (!smokeRoot || !Number.isInteger(port)) {
  throw new Error('Expected a smoke root and port.');
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('ready');
});

server.listen(port, () => {
  fs.writeFileSync(path.join(smokeRoot, 'ready.pid'), String(process.pid));
  process.stdout.write(`ready on ${port}\n`);
});
