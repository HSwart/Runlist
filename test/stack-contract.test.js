const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  STACK_CONTRACT_FILE_CANDIDATES,
  STACK_CONTRACT_SCHEMA_VERSION,
  StackContractError,
  detectStackContract,
  parseStackContract,
  serializeStackContract
} = require('../src/projects/stack-contract');
const { writeProjects, readProjects, upsertRunGroup, readRunGroups } = require('../src/projects/project-store');
const { previewProjectImport } = require('../src/projects/project-transfer');

const FIXTURES = path.join(__dirname, 'fixtures', 'stack-contract');

function workspaceFixture(t, layout = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-stack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
  if (layout.contract) {
    const target = path.join(root, layout.contractName || 'runlist.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, layout.contract);
  }
  return {
    root: fs.realpathSync(root),
    folder(rel) {
      const folderPath = path.join(root, rel);
      fs.mkdirSync(folderPath, { recursive: true });
      return fs.realpathSync(folderPath);
    }
  };
}

test('documents schema version and preferred file candidates', () => {
  assert.equal(STACK_CONTRACT_SCHEMA_VERSION, 1);
  assert.deepEqual(STACK_CONTRACT_FILE_CANDIDATES, [
    'runlist.json',
    path.join('.runlist', 'projects.json')
  ]);
});

test('detects runlist.json before .runlist/projects.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-detect-'));
  fs.mkdirSync(path.join(root, '.runlist'), { recursive: true });
  fs.writeFileSync(path.join(root, '.runlist', 'projects.json'), '{"schemaVersion":1,"projects":[],"groups":[]}');
  fs.writeFileSync(path.join(root, 'runlist.json'), '{"schemaVersion":1,"projects":[],"groups":[]}');
  assert.equal(path.basename(detectStackContract(root)), 'runlist.json');
  fs.unlinkSync(path.join(root, 'runlist.json'));
  assert.equal(
    detectStackContract(root),
    path.join(root, '.runlist', 'projects.json')
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('parses valid golden fixture with relative folders resolved inside workspace', (t) => {
  const fixture = workspaceFixture(t);
  const contents = fs.readFileSync(path.join(FIXTURES, 'valid-runlist.json'), 'utf8');
  const parsed = parseStackContract(contents, { workspaceRoot: fixture.root });
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[0].folder, fixture.root);
  assert.equal(parsed.projects[1].folder, path.join(fixture.root, 'apps', 'api'));
  assert.equal(parsed.projects[0].startCommand, 'npm run dev');
  assert.deepEqual(parsed.projects[0].services, [{ name: 'web', port: 3000 }]);
  assert.deepEqual(parsed.groups[0], {
    name: 'Full stack',
    projectFolders: ['.', 'apps/api'],
    startMode: 'parallel'
  });
  assert.ok(!('env' in parsed.projects[0]));
});

test('rejects absolute folder, path escape, secrets, and unknown schema version', (t) => {
  const fixture = workspaceFixture(t);
  for (const [file, code] of [
    ['invalid-absolute-folder.json', 'PATH_ESCAPE'],
    ['invalid-path-escape.json', 'PATH_ESCAPE'],
    ['invalid-secrets.json', 'SECRETS_FORBIDDEN'],
    ['invalid-schema-version.json', 'UNSUPPORTED_VERSION']
  ]) {
    const contents = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    assert.throws(
      () => parseStackContract(contents, { workspaceRoot: fixture.root }),
      (error) => error instanceof StackContractError && error.code === code,
      file
    );
  }
});

test('serialize writes relative paths only and omits secret-shaped fields', (t) => {
  const fixture = workspaceFixture(t);
  const web = fixture.root;
  const api = path.join(fixture.root, 'apps', 'api');
  const document = serializeStackContract({
    projects: [
      {
        id: 'keep-out',
        name: 'Web',
        folder: web,
        startCommand: 'npm run dev',
        stopCommand: 'npm run stop',
        services: [{ name: 'web', port: 3000 }],
        tags: ['app'],
        composePath: path.join(web, 'compose.yaml'),
        pinned: true,
        reviewRequired: false
      },
      {
        id: 'api-id',
        name: 'API',
        folder: api,
        startCommand: 'npm start',
        services: [{ name: 'api', port: 4000 }]
      }
    ],
    groups: [
      {
        id: 'g1',
        name: 'Full stack',
        projectIds: ['keep-out', 'api-id'],
        startMode: 'parallel'
      }
    ]
  }, { workspaceRoot: fixture.root });

  const parsed = JSON.parse(document);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.projects[0].folder, '.');
  assert.equal(parsed.projects[1].folder, 'apps/api');
  assert.equal(parsed.projects[0].id, undefined);
  assert.equal(parsed.projects[0].composePath, undefined);
  assert.equal(parsed.projects[0].pinned, undefined);
  assert.equal(parsed.projects[0].env, undefined);
  assert.deepEqual(parsed.groups[0].projectFolders, ['.', 'apps/api']);
});

test('allows envFile paths in stack contracts but rejects env maps', (t) => {
  const fixture = workspaceFixture(t);
  const parsed = parseStackContract(JSON.stringify({
    schemaVersion: 1,
    projects: [{
      name: 'Web',
      folder: '.',
      startCommand: 'npm run dev',
      envFile: '.env',
      services: [{ name: 'web', port: 3000 }],
      launchProfiles: [{
        id: 'staging',
        name: 'Staging',
        startCommand: 'npm run start:staging',
        envFile: '.env.staging',
        services: [{ name: 'web', port: 3001 }]
      }]
    }],
    groups: []
  }), { workspaceRoot: fixture.root });
  assert.equal(parsed.projects[0].envFile, '.env');
  assert.equal(parsed.projects[0].launchProfiles[0].envFile, '.env.staging');

  assert.throws(
    () => parseStackContract(JSON.stringify({
      schemaVersion: 1,
      projects: [{
        name: 'Web',
        folder: '.',
        startCommand: 'npm run dev',
        env: { TOKEN: 'nope' },
        services: []
      }],
      groups: []
    }), { workspaceRoot: fixture.root }),
    (error) => error instanceof StackContractError && error.code === 'SECRETS_FORBIDDEN'
  );
});

test('round-trip export then load preview shows no spurious project churn', (t) => {
  const fixture = workspaceFixture(t);
  const projectsFile = path.join(fixture.root, 'storage', 'projects.json');
  fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
  const web = fixture.root;
  const api = path.join(fixture.root, 'apps', 'api');
  const saved = [
    {
      id: 'web-id',
      name: 'Web',
      folder: web,
      startCommand: 'npm run dev',
      services: [{ name: 'web', port: 3000 }],
      tags: ['app'],
      reviewRequired: false
    },
    {
      id: 'api-id',
      name: 'API',
      folder: api,
      startCommand: 'npm start',
      services: [{ name: 'api', port: 4000 }],
      reviewRequired: false
    }
  ];
  writeProjects(projectsFile, saved);
  upsertRunGroup(projectsFile, {
    name: 'Full stack',
    projectIds: ['web-id', 'api-id'],
    startMode: 'parallel'
  });

  const exported = serializeStackContract({
    projects: readProjects(projectsFile),
    groups: readRunGroups(projectsFile)
  }, { workspaceRoot: fixture.root });

  const parsed = parseStackContract(exported, { workspaceRoot: fixture.root });
  const preview = previewProjectImport(readProjects(projectsFile), parsed.projects, {
    replaceOptionalMetadata: false
  });
  assert.equal(preview.changeCount, 0);
  assert.ok(preview.entries.every((entry) => entry.status === 'skip'));
});
