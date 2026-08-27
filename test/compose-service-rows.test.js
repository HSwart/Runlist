const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildComposeServiceRows,
  mergeComposeAutoRows
} = require('../src/compose/compose-service-rows');
const { buildComposeStartCommand } = require('../src/compose/compose-runtime');

test('builds one row per compose service with --no-deps start', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-rows-'));
  fs.writeFileSync(path.join(folder, 'compose.yaml'), `
services:
  web:
    image: nginx
    ports: ["3000:80"]
  db:
    image: postgres
`);
  const rows = buildComposeServiceRows({
    folder,
    existingProjects: [{ id: 'app', name: 'web', folder }]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'web-2');
  assert.equal(rows[1].name, 'db');
  assert.match(rows[0].startCommand, /up --no-deps/);
  assert.match(rows[0].stopCommand, /\bstop\b/);
  assert.equal(rows[0].composeAutoRow, true);
  assert.equal(rows[0].services[0].port, '3000');
});

test('merge keeps saved projects and adds compose rows', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-compose-merge-'));
  fs.writeFileSync(path.join(folder, 'docker-compose.yml'), `
services:
  api:
    image: node
    ports: ["4000:4000"]
`);
  const merged = mergeComposeAutoRows([
    { id: 'saved', name: 'App', folder, startCommand: 'npm start', services: [] }
  ]);
  assert.equal(merged[0].id, 'saved');
  assert.equal(merged.length, 2);
  assert.equal(merged[1].composeServiceName, 'api');
});

test('compose runtime adds --no-deps for auto rows', () => {
  const command = buildComposeStartCommand({
    composePath: '/tmp/compose.yaml',
    composeServices: ['web'],
    composeAutoRow: true
  });
  assert.match(command, /up --no-deps web/);
});
