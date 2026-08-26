const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVSIX, PackageManager } = require('@vscode/vsce');
const {
  REVIEWED_PACKAGE_FILES,
  REVIEWED_PACKAGING_CONTROL_FILES,
  assertArchiveMatchesAllowlist,
  expectedArchiveFiles,
  packageVsix,
  replaceArtifact
} = require('../scripts/package-vsix');
const { readArchive } = require('../scripts/validate-vsix');

const root = path.join(__dirname, '..');

test('routes the package command through the reviewed staging boundary', () => {
  const manifest = require('../package.json');
  assert.equal(
    manifest.scripts.package,
    'npm run validate:marketplace:publish && node scripts/package-vsix.js'
  );
});

function temporaryFixtureRoot(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'runlist-package-fixture-'
  ));
  for (const file of [...REVIEWED_PACKAGE_FILES, ...REVIEWED_PACKAGING_CONTROL_FILES]) {
    const sourcePath = path.join(root, ...file.split('/'));
    const targetPath = path.join(fixtureRoot, ...file.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  return fixtureRoot;
}

function temporaryOutput(fixtureRoot) {
  const directory = path.join(fixtureRoot, 'test-output');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'candidate.vsix');
}

function temporaryCandidate(t, contents = 'candidate bytes') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-candidate-input-'));
  const candidatePath = path.join(directory, 'candidate.vsix');
  fs.writeFileSync(candidatePath, contents);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return candidatePath;
}

function addPackageRouteFiles(fixtureRoot) {
  for (const file of [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'docs/marketplace-release.md',
    'scripts/package-vsix.js',
    'scripts/validate-marketplace.js',
    'scripts/validate-vsix.js'
  ]) {
    const sourcePath = path.join(root, ...file.split('/'));
    const targetPath = path.join(fixtureRoot, ...file.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  fs.mkdirSync(path.join(fixtureRoot, 'releases'), { recursive: true });
}

function createLinkOrSkip(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip(`platform or privilege does not permit ${type} links`);
      return false;
    }
    throw error;
  }
}

test('packages only the reviewed allowlist and excludes untracked root inputs', async (t) => {
  const sentinelName = `package-sentinel-${crypto.randomUUID()}.txt`;
  const secretName = `.env.package-${crypto.randomUUID()}`;
  const fixtureRoot = temporaryFixtureRoot(t);
  const sentinelPath = path.join(fixtureRoot, sentinelName);
  const secretPath = path.join(fixtureRoot, secretName);
  fs.writeFileSync(sentinelPath, 'non-secret sentinel\n');
  fs.writeFileSync(secretPath, 'DO_NOT_PACKAGE=secret\n');
  t.after(() => {
    fs.rmSync(sentinelPath, { force: true });
    fs.rmSync(secretPath, { force: true });
  });

  const outputPath = temporaryOutput(fixtureRoot);
  await packageVsix(fixtureRoot, { outputPath, testOnly: true });
  const archive = await readArchive(outputPath);
  const names = new Set(archive.keys());

  assert.deepEqual(names, expectedArchiveFiles());
  assert.equal(names.has(`extension/${sentinelName}`), false);
  assert.equal(names.has(`extension/${secretName}`), false);
  assert.equal(names.has('extension/CODEBASE_REVIEW.md'), false);
  assert.equal(REVIEWED_PACKAGE_FILES.includes(sentinelName), false);
});

const GALLERY_STILLS = Object.freeze([
  'media/gallery-01-hero.png',
  'media/gallery-02-status.png',
  'media/gallery-03-features.png'
]);

function assertPngBytes(bytes, label) {
  assert.ok(bytes, `missing ${label}`);
  assert.notEqual(bytes.toString('utf8', 0, 32).startsWith('version https://git-lfs.github.com/'), true, `${label} is a Git LFS pointer`);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${label} is not PNG bytes`);
}

test('ships signed gallery PNGs and keeps relative README image sources in the VSIX', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  await packageVsix(fixtureRoot, { outputPath, testOnly: true });
  const archive = await readArchive(outputPath);
  const readme = archive.get('extension/readme.md').toString('utf8');
  const packagedManifest = JSON.parse(archive.get('extension/package.json').toString('utf8'));

  assert.deepEqual(
    packagedManifest.screenshots,
    GALLERY_STILLS.map((screenshotPath) => ({ path: screenshotPath }))
  );
  for (const screenshotPath of GALLERY_STILLS) {
    assertPngBytes(archive.get(`extension/${screenshotPath}`), screenshotPath);
    assert.match(readme, new RegExp(`src="${screenshotPath.replaceAll('.', '\\.')}"`));
  }
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /github\.com\/HSwart\/Runlist\/raw\//);
});

test('npm run package invokes the reviewed helper in an isolated fixture', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  addPackageRouteFiles(fixtureRoot);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCommand, ['run', 'package', '--prefix', fixtureRoot], {
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH: path.join(root, 'node_modules')
    },
    shell: process.platform === 'win32',
    stdio: 'pipe'
  });
  const archivePath = path.join(fixtureRoot, 'releases', 'runlist.vsix');
  const archive = await readArchive(archivePath);
  assert.deepEqual(new Set(archive.keys()), expectedArchiveFiles());
});

test('rejects a staged manifest vscode:prepublish script before VSCE runs', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const sentinelPath = path.join(fixtureRoot, 'prepublish-sentinel.txt');
  const manifestPath = path.join(fixtureRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.scripts['vscode:prepublish'] = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'executed')"`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    packageVsix(fixtureRoot, { outputPath: temporaryOutput(fixtureRoot), testOnly: true }),
    /scripts\.vscode:prepublish/
  );
  assert.equal(fs.existsSync(sentinelPath), false);
});

test('rejects a missing reviewed input before installing output', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const missingPath = path.join(fixtureRoot, 'src', 'projects', 'project-store.js');
  fs.rmSync(missingPath);
  const outputPath = temporaryOutput(fixtureRoot);
  const original = Buffer.from('original release bytes');
  fs.writeFileSync(outputPath, original);

  await assert.rejects(
    packageVsix(fixtureRoot, { outputPath, testOnly: true }),
    /reviewed file is missing/
  );
  assert.deepEqual(fs.readFileSync(outputPath), original);
});

test('rejects a reviewed source file symlink', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const sourcePath = path.join(fixtureRoot, 'src', 'projects', 'project-store.js');
  const outsidePath = path.join(os.tmpdir(), `runlist-source-${crypto.randomUUID()}.js`);
  fs.writeFileSync(outsidePath, 'outside');
  t.after(() => fs.rmSync(outsidePath, { force: true }));
  fs.rmSync(sourcePath);
  if (!createLinkOrSkip(t, outsidePath, sourcePath, 'file')) return;

  await assert.rejects(
    packageVsix(fixtureRoot, { outputPath: temporaryOutput(fixtureRoot), testOnly: true }),
    /symlink, junction, or reparse-point/
  );
});

test('rejects a reviewed parent directory symlink or junction', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const sourceDirectory = path.join(fixtureRoot, 'src', 'projects');
  const outsideDirectory = path.join(os.tmpdir(), `runlist-projects-${crypto.randomUUID()}`);
  fs.mkdirSync(outsideDirectory);
  t.after(() => fs.rmSync(outsideDirectory, { recursive: true, force: true }));
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!createLinkOrSkip(t, outsideDirectory, sourceDirectory, linkType)) return;

  await assert.rejects(
    packageVsix(fixtureRoot, { outputPath: temporaryOutput(fixtureRoot), testOnly: true }),
    /symlink, junction, or reparse-point/
  );
});

test('rejects an unexpected archive entry before replacing output', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const original = Buffer.from('original release bytes');
  fs.writeFileSync(outputPath, original);

  await assert.rejects(
    packageVsix(fixtureRoot, {
      outputPath,
      testOnly: true,
      createCandidate: async ({ cwd, packagePath }) => {
        fs.writeFileSync(path.join(cwd, 'unreviewed-root-input.txt'), 'sentinel');
        await createVSIX({
          cwd,
          dependencies: false,
          packageManager: PackageManager.None,
          packagePath
        });
      }
    }),
    /unexpected entries: extension\/unreviewed-root-input\.txt/
  );
  assert.deepEqual(fs.readFileSync(outputPath), original);
});

test('preserves old output bytes when installation fails', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const original = Buffer.from('original release bytes');
  fs.writeFileSync(outputPath, original);

  await assert.rejects(
    packageVsix(fixtureRoot, {
      outputPath,
      testOnly: true,
      installArtifact: () => { throw new Error('injected install failure'); }
    }),
    /injected install failure/
  );
  assert.deepEqual(fs.readFileSync(outputPath), original);
  assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ['candidate.vsix']);
});

test('atomically replaces a temporary output only after validation', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  fs.writeFileSync(outputPath, 'old bytes');

  await packageVsix(fixtureRoot, { outputPath, testOnly: true });
  const archive = await readArchive(outputPath);
  assert.deepEqual(new Set(archive.keys()), expectedArchiveFiles());
  assert.notEqual(fs.readFileSync(outputPath, 'utf8'), 'old bytes');
  assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ['candidate.vsix']);
});

test('rejects an output file symlink without following it', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const outsidePath = path.join(os.tmpdir(), `runlist-output-${crypto.randomUUID()}.vsix`);
  fs.writeFileSync(outsidePath, 'outside bytes');
  t.after(() => fs.rmSync(outsidePath, { force: true }));
  fs.rmSync(outputPath, { force: true });
  if (!createLinkOrSkip(t, outsidePath, outputPath, 'file')) return;

  await assert.rejects(
    packageVsix(fixtureRoot, { outputPath, testOnly: true }),
    /symlink, junction, or reparse-point/
  );
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside bytes');
});

test('rejects an output parent directory symlink or junction', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputParent = path.join(fixtureRoot, 'linked-output');
  const outsideDirectory = path.join(os.tmpdir(), `runlist-output-dir-${crypto.randomUUID()}`);
  fs.mkdirSync(outsideDirectory);
  t.after(() => fs.rmSync(outsideDirectory, { recursive: true, force: true }));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!createLinkOrSkip(t, outsideDirectory, outputParent, linkType)) return;

  await assert.rejects(
    packageVsix(fixtureRoot, { outputPath: path.join(outputParent, 'candidate.vsix'), testOnly: true }),
    /symlink, junction, or reparse-point/
  );
});

test('preserves old output bytes when the real installer copy fails', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const original = Buffer.from('original release bytes');
  fs.writeFileSync(outputPath, original);

  await assert.rejects(
    packageVsix(fixtureRoot, {
      outputPath,
      testOnly: true,
      fsOps: { writeSync: () => { throw new Error('injected temp copy failure'); } }
    }),
    /injected temp copy failure/
  );
  assert.deepEqual(fs.readFileSync(outputPath), original);
  assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ['candidate.vsix']);
});

test('cleans an installer-owned partial temporary copy after failure', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const original = Buffer.from('original release bytes');
  fs.writeFileSync(outputPath, original);

  await assert.rejects(
    packageVsix(fixtureRoot, {
      outputPath,
      testOnly: true,
      fsOps: {
        writeSync: (descriptor, buffer, offset, length) => {
          fs.writeSync(descriptor, buffer, offset, Math.min(length, 8));
          throw new Error('injected partial temp copy failure');
        }
      }
    }),
    /injected partial temp copy failure/
  );
  assert.deepEqual(fs.readFileSync(outputPath), original);
  assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ['candidate.vsix']);
});

test('preserves old output bytes when the real installer rename fails', async (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const original = Buffer.from('original release bytes');
  fs.writeFileSync(outputPath, original);

  await assert.rejects(
    packageVsix(fixtureRoot, {
      outputPath,
      testOnly: true,
      fsOps: { renameSync: () => { throw new Error('injected temp rename failure'); } }
    }),
    /injected temp rename failure/
  );
  assert.deepEqual(fs.readFileSync(outputPath), original);
  assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ['candidate.vsix']);
});

test('does not overwrite a precreated temporary link or path', (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const candidatePath = temporaryCandidate(t);
  fs.writeFileSync(outputPath, 'original release bytes');
  const temporaryPath = path.join(path.dirname(outputPath), '.candidate.vsix.fixed.tmp');
  const outsidePath = path.join(os.tmpdir(), `runlist-temp-target-${crypto.randomUUID()}.vsix`);
  fs.writeFileSync(outsidePath, 'outside bytes');
  t.after(() => fs.rmSync(outsidePath, { force: true }));
  if (!createLinkOrSkip(t, outsidePath, temporaryPath, 'file')) return;

  assert.throws(
    () => replaceArtifact(candidatePath, outputPath, { temporaryPath }),
    /symlink, junction, or reparse-point|already exists|EEXIST/i
  );
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside bytes');
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original release bytes');
});

test('rejects an output-parent identity change between copy and rename', (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const candidatePath = temporaryCandidate(t);
  fs.writeFileSync(outputPath, 'original release bytes');
  const parentIdentity = { dev: 1, ino: 2, mode: 0o40755, size: 1, type: 'directory' };
  let validations = 0;

  assert.throws(
    () => replaceArtifact(candidatePath, outputPath, {
      validateOutput: () => ({
        parentIdentity: validations++ === 0 ? parentIdentity : { ...parentIdentity, ino: 3 }
      })
    }),
    /changed output parent identity/
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original release bytes');
  assert.equal(fs.existsSync(path.join(path.dirname(outputPath), '.candidate.vsix.fixed.tmp')), false);
});

test('allows output-parent size changes when stable directory identity is unchanged', (t) => {
  const fixtureRoot = temporaryFixtureRoot(t);
  const outputPath = temporaryOutput(fixtureRoot);
  const candidatePath = temporaryCandidate(t, 'new bytes');
  fs.writeFileSync(outputPath, 'original release bytes');
  const parentIdentity = { dev: 1, ino: 2, mode: 0o40755, size: 1, type: 'directory' };
  let validations = 0;

  assert.doesNotThrow(() => replaceArtifact(candidatePath, outputPath, {
    validateOutput: () => ({
      parentIdentity: validations++ === 0 ? parentIdentity : { ...parentIdentity, size: 99 }
    })
  }));
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'new bytes');
});

test('fails closed when an archive contains an unexpected staging input', () => {
  const archive = new Map([
    ['[Content_Types].xml', Buffer.from('types')],
    ['extension.vsixmanifest', Buffer.from('manifest')],
    ...[...expectedArchiveFiles()]
      .filter((file) => !['[Content_Types].xml', 'extension.vsixmanifest'].includes(file))
      .map((file) => [file, Buffer.from('reviewed')]),
    ['extension/unreviewed-root-input.txt', Buffer.from('sentinel')]
  ]);

  assert.throws(
    () => assertArchiveMatchesAllowlist(archive),
    /unexpected entries: extension\/unreviewed-root-input\.txt/
  );
});

test('fails closed when a required reviewed file is missing from the archive', () => {
  const archive = new Map(
    [...expectedArchiveFiles()]
      .filter((file) => file !== 'extension/extension.js')
      .map((file) => [file, Buffer.from('reviewed')])
  );

  assert.throws(
    () => assertArchiveMatchesAllowlist(archive),
    /missing reviewed entries: extension\/extension\.js/
  );
});
