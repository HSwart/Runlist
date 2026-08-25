const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/]
];

function detectSecrets(contents) {
  return SECRET_PATTERNS
    .filter(([, pattern]) => pattern.test(contents))
    .map(([label]) => label);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8'
  }).split('\0').filter(Boolean);
}

function scanCurrentTree() {
  const findings = [];
  for (const file of trackedFiles()) {
    if (/(^|\/)\.env(?:\.|$)/.test(file) && !/\.example$/i.test(file)) {
      findings.push({ file, label: 'tracked-env-file' });
      continue;
    }
    const contents = fs.readFileSync(path.join(root, file));
    if (contents.length > 1024 * 1024 || contents.includes(0)) {
      continue;
    }
    for (const label of detectSecrets(contents.toString('utf8'))) {
      findings.push({ file, label });
    }
  }
  return findings;
}

function scanHistory() {
  const patch = execFileSync('git', [
    'log',
    '--all',
    '--format=commit:%H',
    '--no-ext-diff',
    '--unified=0',
    '-p'
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024
  });
  const findings = [];
  let commit = 'unknown';
  let file = 'unknown';
  for (const line of patch.split('\n')) {
    if (line.startsWith('commit:')) {
      commit = line.slice(7, 19);
    } else if (line.startsWith('+++ b/')) {
      file = line.slice(6);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      for (const label of detectSecrets(line.slice(1))) {
        findings.push({ commit, file, label });
      }
    }
  }
  return findings;
}

function run() {
  const findings = [...scanCurrentTree(), ...scanHistory()];
  if (findings.length) {
    const summary = findings.slice(0, 20)
      .map(({ commit, file, label }) => `${commit ? `${commit}:` : ''}${file} (${label})`)
      .join('\n');
    throw new Error(`Potential committed secrets detected:\n${summary}`);
  }
  process.stdout.write('High-confidence secret scan passed for the current tree and Git history.\n');
}

if (require.main === module) {
  run();
}

module.exports = { detectSecrets };
