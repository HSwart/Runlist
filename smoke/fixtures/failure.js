const fs = require('fs');

const pidPath = process.argv[2];
if (!pidPath) {
  throw new Error('Expected a fixture pid path.');
}
fs.writeFileSync(pidPath, String(process.pid));
process.stderr.write('controlled smoke failure\n');
process.exitCode = 7;
