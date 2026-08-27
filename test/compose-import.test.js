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
  composeImportServicesForSave,
  parseComposeServices
} = require('../src/compose/compose-parse');
const {
  initializeProjectStore,
  upsertProject
} = require('../src/projects/project-store');

test('detects compose.yml, compose.yaml, and docker-compose.yml in preference order', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-yml-'));
  fs.writeFileSync(path.join(folder, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(folder, 'compose.yml'), 'services: {}\n');
  assert.deepEqual(
    detectComposeFiles(folder).map((file) => path.basename(file)),
    ['compose.yml', 'docker-compose.yml']
  );
  assert.equal(path.basename(resolveComposeFile(folder)), 'compose.yml');
  fs.rmSync(folder, { recursive: true, force: true });
});

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

test('parses Docker image tags with colons in service definitions', () => {
  const parsed = parseComposeServices(`
services:
  web:
    image: nginx:alpine
    ports:
      - "4310:80"
  api:
    image: ghcr.io/acme/api:v1.2.3
    ports:
      - "7071:3000"
`);
  assert.equal(parsed.services.length, 2);
  assert.deepEqual(parsed.services[0].ports, [4310]);
  assert.deepEqual(parsed.services[1].ports, [7071]);
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
    { name: 'web', port: 4310, url: '' }
  ]);
  assert.equal(proposal.proposedProject.reviewRequired, false);
  assert.equal(proposal.proposedProject.composePath, '/tmp/acme/compose.yaml');
  assert.match(proposal.warnings[0], /db has no published host port/);
  assert.doesNotMatch(proposal.proposedProject.startCommand, /docker compose up -d/);
});

test('Compose import Save coerces numeric-string ports to integers and rejects garbage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-save-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const composePath = path.join(folder, 'compose.yaml');
  fs.writeFileSync(composePath, `
services:
  web:
    ports:
      - "4310:80"
  api:
    ports:
      - target: 3000
        published: 7071
`.trimStart());
  const projectsFile = path.join(root, 'projects.json');
  initializeProjectStore(projectsFile, []);

  const proposal = buildComposeImportProposal({
    folder,
    composePath,
    contents: fs.readFileSync(composePath, 'utf8')
  });
  assert.equal(typeof proposal.proposedProject.services[0].port, 'number');
  assert.equal(proposal.proposedProject.services[0].port, 4310);

  const fromStrings = composeImportServicesForSave([
    { name: 'web', port: '4310', url: '' },
    { name: 'api', port: 7071, url: '' }
  ]);
  assert.deepEqual(fromStrings, [
    { name: 'web', port: 4310, url: '' },
    { name: 'api', port: 7071, url: '' }
  ]);

  const saved = upsertProject(projectsFile, {
    ...proposal.proposedProject,
    services: composeImportServicesForSave([
      { name: 'web', port: '4310', url: '' },
      { name: 'api', port: '7071', url: '' }
    ])
  }).project;
  assert.equal(saved.services[0].port, 4310);
  assert.equal(saved.services[1].port, 7071);
  assert.equal(typeof saved.services[0].port, 'number');
  assert.equal(typeof saved.services[1].port, 'number');

  assert.throws(() => upsertProject(projectsFile, {
    ...proposal.proposedProject,
    services: composeImportServicesForSave([{ name: 'web', port: 'not-a-port', url: '' }])
  }), /integer from 1 to 65535/);
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

test('Compose import fills the existing envFile field from env_file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-env-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  const composePath = path.join(folder, 'compose.yaml');
  fs.writeFileSync(composePath, `
env_file: .env
services:
  web:
    ports:
      - "4310:80"
`.trimStart());
  const projectsFile = path.join(root, 'projects.json');
  initializeProjectStore(projectsFile, []);

  const proposal = buildComposeImportProposal({
    folder,
    composePath,
    contents: fs.readFileSync(composePath, 'utf8')
  });
  assert.equal(proposal.proposedProject.envFile, '.env');

  const saved = upsertProject(projectsFile, proposal.proposedProject).project;
  assert.equal(saved.envFile, '.env');

  fs.writeFileSync(path.join(folder, '.env'), 'COMPOSE_SECRET=from-file\nPORT=4310\n');
  const { resolveProjectLaunchEnvironment } = require('../src/projects/launch-env');
  const environment = resolveProjectLaunchEnvironment(saved, { PATH: '/usr/bin' });
  assert.equal(environment.COMPOSE_SECRET, 'from-file');
  assert.equal(environment.PORT, '4310');
});

test('Compose import Start fails closed when the attached env_file is missing', () => {
  const proposal = buildComposeImportProposal({
    folder: '/tmp/acme',
    composePath: '/tmp/acme/compose.yaml',
    contents: `
services:
  web:
    env_file:
      - .env
    ports:
      - "4310:80"
`
  });
  assert.equal(proposal.proposedProject.envFile, '.env');
  const { LaunchEnvError, resolveProjectLaunchEnvironment } = require('../src/projects/launch-env');
  assert.throws(
    () => resolveProjectLaunchEnvironment(proposal.proposedProject, { PATH: '/usr/bin' }),
    (error) => error instanceof LaunchEnvError
      && error.code === 'ENV_FILE_MISSING'
      && /Could not find env file “\.env”/i.test(error.message)
  );
});

test('Compose import skips invalid env_file paths and leaves add-form env file unchanged', () => {
  const proposal = buildComposeImportProposal({
    folder: '/tmp/acme',
    contents: `
services:
  web:
    env_file: ../secret.env
    ports:
      - "4310:80"
`
  });
  assert.equal(proposal.proposedProject.envFile, undefined);

  const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  assert.match(webview, /id="env-file" name="envFile"/);
  const composeRender = webview.slice(
    webview.indexOf('function renderComposeImport'),
    webview.indexOf('function renderPortListening')
  );
  assert.doesNotMatch(composeRender, /id="env-file"|name="envFile"/);
});
