const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  COMPOSE_FILE_NAMES,
  ComposeFileError,
  detectComposeFiles,
  resolveComposeFile
} = require('../src/compose/compose-file');
const {
  buildComposeImportProposal,
  parseComposeServices
} = require('../src/compose/compose-parse');

test('detects compose.yaml and docker-compose.yml in preference order', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-'));
  fs.writeFileSync(path.join(folder, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(folder, 'compose.yaml'), 'services: {}\n');
  assert.deepEqual(
    detectComposeFiles(folder).map((file) => path.basename(file)),
    ['compose.yaml', 'docker-compose.yml']
  );
  assert.equal(path.basename(resolveComposeFile(folder)), 'compose.yaml');
  assert.deepEqual(COMPOSE_FILE_NAMES[0], 'compose.yaml');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('parses service names, published ports, and profiles from valid Compose', () => {
  const parsed = parseComposeServices(`
services:
  web:
    ports:
      - "4310:4310"
      - 127.0.0.1:8080:80
    profiles:
      - frontend
  api:
    ports:
      - target: 3000
        published: 7071
  worker:
    image: example/worker
`);
  assert.equal(parsed.services.length, 3);
  assert.deepEqual(parsed.services[0], {
    name: 'web',
    ports: [4310, 8080],
    profiles: ['frontend'],
    note: undefined
  });
  assert.equal(parsed.services[1].name, 'api');
  assert.deepEqual(parsed.services[1].ports, [7071]);
  assert.deepEqual(parsed.services[2].ports, []);
  assert.match(parsed.services[2].note, /No published host ports/);
});

test('builds a reviewable Runlist proposal without starting anything', () => {
  const proposal = buildComposeImportProposal({
    folder: '/tmp/acme',
    projectName: 'Acme',
    composePath: '/tmp/acme/compose.yaml',
    contents: `
services:
  web:
    ports:
      - "4310:4310"
  db:
    image: postgres
`
  });
  assert.equal(proposal.proposedProject.name, 'Acme');
  assert.equal(proposal.proposedProject.folder, '/tmp/acme');
  assert.equal(proposal.proposedProject.startCommand, 'docker compose up web db');
  assert.equal(proposal.proposedProject.stopCommand, 'docker compose stop web db');
  assert.deepEqual(proposal.proposedProject.services, [
    { name: 'web', port: '4310', url: '' }
  ]);
  assert.equal(proposal.proposedProject.reviewRequired, false);
  assert.equal(proposal.proposedProject.composePath, '/tmp/acme/compose.yaml');
  assert.match(proposal.warnings[0], /db has no published host port/);
  assert.doesNotMatch(proposal.proposedProject.startCommand, /docker compose up -d/);
});

test('fails closed on missing file, invalid YAML, anchors, and port ranges', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-empty-'));
  assert.throws(() => resolveComposeFile(folder), (error) => (
    error instanceof ComposeFileError && error.code === 'COMPOSE_NOT_FOUND'
  ));
  fs.rmSync(folder, { recursive: true, force: true });

  assert.throws(() => parseComposeServices('services: ['), (error) => (
    error instanceof ComposeFileError && /valid YAML|could not/i.test(error.message)
  ));
  assert.throws(() => parseComposeServices(`
services:
  web: &anchor
    ports:
      - "3000:3000"
`), (error) => error instanceof ComposeFileError && error.code === 'COMPOSE_UNSUPPORTED_YAML');

  assert.throws(() => parseComposeServices(`
services:
  web:
    ports:
      - "3000-3005:3000-3005"
`), (error) => error instanceof ComposeFileError && error.code === 'COMPOSE_PORT_RANGE');
});

test('prefers an explicit Compose path over auto-detection', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-pick-'));
  fs.writeFileSync(path.join(folder, 'compose.yaml'), 'services:\n  a:\n    ports: ["1:1"]\n');
  const override = path.join(folder, 'docker-compose.yml');
  fs.writeFileSync(override, 'services:\n  b:\n    ports: ["2:2"]\n');
  assert.equal(resolveComposeFile(folder, override), path.resolve(override));
  const proposal = buildComposeImportProposal({
    folder,
    composePath: override,
    contents: fs.readFileSync(override, 'utf8')
  });
  assert.equal(proposal.parsedServices[0].name, 'b');
  fs.rmSync(folder, { recursive: true, force: true });
});
