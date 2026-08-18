const fs = require('fs');

const [pidPath, evidencePath] = process.argv.slice(2);
const pid = Number(fs.readFileSync(pidPath, 'utf8'));
process.kill(pid);
fs.writeFileSync(evidencePath, String(pid));
