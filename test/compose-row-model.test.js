const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildComposeImportProposal } = require('../src/compose/compose-parse');
const {
  initializeProjectStore,
  readProjects,
  upsertProject
} = require('../src/projects/project-store');
const { projectStatusAnnouncement } = require('../media/project-status-display');

const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');

test('Compose import proposes one project row with published-port services and composePath', () => {
  const proposal = buildComposeImportProposal({
    folder: '/tmp/acme',
    projectName: 'Acme',
    composePath: '/tmp/acme/compose.yaml',
    contents: `
services:
  web:
    ports:
      - "4310:4310"
    profiles:
      - frontend
  worker:
    image: example/worker
`
  });
  assert.equal(proposal.proposedProject.name, 'Acme');
  assert.equal(proposal.proposedProject.composePath, '/tmp/acme/compose.yaml');
  assert.deepEqual(proposal.proposedProject.services, [
    { name: 'web', port: 4310, url: '' }
  ]);
  assert.match(proposal.proposedProject.startCommand, /docker compose up web worker/);
});

test('project store persists composePath on schema 6 without inventing nested sidebar rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-row-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'app');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'compose.yaml'), 'services:\n  web:\n    ports: ["1:1"]\n');
  const projectsFile = path.join(root, 'projects.json');
  initializeProjectStore(projectsFile, []);
  const saved = upsertProject(projectsFile, {
    name: 'Compose App',
    folder,
    startCommand: 'docker compose up web',
    stopCommand: 'docker compose stop web',
    services: [{ name: 'web', port: 4310, url: '' }],
    composePath: path.join(folder, 'compose.yaml'),
    reviewRequired: false
  }).project;
  assert.equal(saved.composePath, path.join(folder, 'compose.yaml'));
  const document = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.equal(document.schemaVersion, 11);
  assert.equal(readProjects(projectsFile)[0].composePath, saved.composePath);
});

test('webview marks Compose projects on Frame B without a third permanent line', () => {
  assert.match(webview, /data-compose="true"/);
  assert.match(webview, /Compose project/);
  assert.match(webview, /compose-kind-icon/);
  assert.match(webview, /icon\('layers', 'project-kind-icon compose-kind-icon'\)/);
  assert.doesNotMatch(webview, /project-compose-cue/);
  assert.doesNotMatch(styles, /\.project-compose-cue/);
  assert.doesNotMatch(webview, /compose-service-row|nested-compose-dashboard/);
});

test('screen-reader status announces Compose projects distinctly', () => {
  assert.match(
    projectStatusAnnouncement({ name: 'Demo', composePath: '/tmp/compose.yaml', status: 'stopped' }),
    /Compose project\. Demo:/
  );
  assert.doesNotMatch(
    projectStatusAnnouncement({ name: 'Native', status: 'stopped' }),
    /Compose project/
  );
});
