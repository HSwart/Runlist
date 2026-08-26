const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { createVSIX, PackageManager } = require('@vscode/vsce');
const yazl = require('yazl');
const { readArchive } = require('./validate-vsix');

// This is the reviewed extension boundary.  Packaging starts from this list,
// rather than from the workspace, so an untracked report, secret, or temporary
// file cannot become part of the VSIX by accident.
const REVIEWED_PACKAGE_FILES = Object.freeze([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'extension.js',
  'mcp/server.js',
  'media/gallery-01-hero.png',
  'media/gallery-02-status.png',
  'media/gallery-03-features.png',
  'media/main.js',
  'media/message-router.js',
  'media/project-actions.js',
  'media/project-status-display.js',
  'media/runlist-preview.png',
  'media/runlist.png',
  'media/runlist.svg',
  'media/styles.css',
  'package.json',
  'skills/runlist/SKILL.md',
  'skills/runlist/agents/openai.yaml',
  'src/groups/run-groups.js',
  'src/host/runlist-host-role.js',
  'src/host/runlist-view-provider.js',
  'src/integrations/agent-registration.js',
  'src/integrations/skill-installation.js',
  'src/lifecycle/atomic-json-record.js',
  'src/lifecycle/bounded-work.js',
  'src/lifecycle/custom-stop-recovery.js',
  'src/lifecycle/exclusive-json-lock.js',
  'src/lifecycle/lifecycle-capability.js',
  'src/lifecycle/process-identity.js',
  'src/lifecycle/process-lock.js',
  'src/lifecycle/process-metrics.js',
  'src/lifecycle/process-supervisor.js',
  'src/lifecycle/project-lifecycle.js',
  'src/lifecycle/project-process.js',
  'src/lifecycle/project-status.js',
  'src/lifecycle/runlist-diagnostics.js',
  'src/lifecycle/runtime-process-owner.js',
  'src/lifecycle/runtime-pulse.js',
  'src/lifecycle/startup-history.js',
  'src/ports/port-gate.js',
  'src/ports/port-process.js',
  'src/ports/port-recovery.js',
  'src/ports/listener-identity.js',
  'src/ports/port-listening-report.js',
  'src/ports/row-listener-owner.js',
  'src/ports/service-port-overrides.js',
  'src/compose/compose-file.js',
  'src/compose/compose-parse.js',
  'src/projects/launch-profile.js',
  'src/projects/project-diagnostics.js',
  'src/projects/project-form.js',
  'src/projects/project-output.js',
  'src/projects/project-repair.js',
  'src/projects/project-search.js',
  'src/projects/project-store.js',
  'src/projects/project-tags.js',
  'src/projects/project-transfer.js',
  'src/projects/project-workspace.js',
  'src/services/external-url.js',
  'src/webview/phone-handoff.js',
  'src/webview/preview-security.js',
  'src/webview/project-detail-tabs.js',
  'src/webview/project-navigation.js',
  'src/webview/webview-message-router.js',
  'vendor/qrcode-generator.js'
]);

const REVIEWED_PACKAGING_CONTROL_FILES = Object.freeze(['.vscodeignore']);

const GENERATED_ARCHIVE_FILES = Object.freeze([
  '[Content_Types].xml',
  'extension.vsixmanifest'
]);

const GALLERY_SCREENSHOTS = Object.freeze([
  'media/gallery-01-hero.png',
  'media/gallery-02-status.png',
  'media/gallery-03-features.png'
]);

const GITHUB_RAW_README = /raw\.githubusercontent\.com|\/raw\/HEAD\//;

function screenshotAssetType(index) {
  return `Microsoft.VisualStudio.Services.Screenshots.${index + 1}`;
}

function marketplaceScreenshotUrl(manifest, index) {
  const publisher = manifest.publisher;
  const name = manifest.name;
  const version = manifest.version;
  if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string'
    || publisher.trim() === '' || name.trim() === '' || version.trim() === '') {
    throw new Error('Refusing to package screenshot URLs without publisher, name, and version');
  }
  return `https://${publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/${publisher}/extension/${name}/${version}/assetbyname/${screenshotAssetType(index)}`;
}

function archiveFile(archive, name) {
  const bytes = archive.get(name);
  if (!bytes) {
    throw new Error(`Refusing to package because ${name} is missing from the VSIX`);
  }
  return bytes;
}

function assertPngBytes(bytes, label) {
  if (bytes.toString('utf8', 0, 32).startsWith('version https://git-lfs.github.com/')) {
    throw new Error(`Refusing to package because ${label} is a Git LFS pointer`);
  }
  if (bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error(`Refusing to package because ${label} is not PNG bytes`);
  }
}

function screenshotAssetTag(index) {
  return `<Asset Type="${screenshotAssetType(index)}" Path="extension/${GALLERY_SCREENSHOTS[index]}" Addressable="true" />`;
}

function rewritePackagedReadme(readme, manifest) {
  if (GITHUB_RAW_README.test(readme)) {
    throw new Error('Refusing to package a README that uses GitHub-raw image URLs');
  }

  let result = readme;
  GALLERY_SCREENSHOTS.forEach((screenshotPath, index) => {
    const relativeSrc = `src="${screenshotPath}"`;
    if (!result.includes(relativeSrc)) {
      throw new Error(`Refusing to package because README is missing relative ${relativeSrc}`);
    }
    result = result.replaceAll(relativeSrc, `src="${marketplaceScreenshotUrl(manifest, index)}"`);
  });

  if (GITHUB_RAW_README.test(result) || /src="media\/gallery-/.test(result)) {
    throw new Error('Refusing to package a README that is not Marketplace-addressable');
  }
  return result;
}

function addScreenshotAssets(vsixManifest) {
  if (/Microsoft\.VisualStudio\.Services\.Screenshots\./.test(vsixManifest)
    || /Microsoft\.VisualStudio\.Services\.Content\.Screenshot/.test(vsixManifest)) {
    throw new Error('Refusing to package because vsixmanifest already declares screenshot assets');
  }
  if (!vsixManifest.includes('</Assets>')) {
    throw new Error('Refusing to package because vsixmanifest is missing an Assets section');
  }
  const extra = GALLERY_SCREENSHOTS.map((_, index) => screenshotAssetTag(index)).join('\n');
  return vsixManifest.replace('</Assets>', `${extra}\n\t\t</Assets>`);
}

function assertMarketplaceGalleryPackaging(archive) {
  const manifest = JSON.parse(archiveFile(archive, 'extension/package.json').toString('utf8'));
  const readme = archiveFile(archive, 'extension/readme.md').toString('utf8');
  const vsixManifest = archiveFile(archive, 'extension.vsixmanifest').toString('utf8');

  if (GITHUB_RAW_README.test(readme)) {
    throw new Error('Refusing to package a README that uses GitHub-raw image URLs');
  }
  if (/src="media\/gallery-/.test(readme)) {
    throw new Error('Refusing to package a README with relative gallery image sources');
  }

  GALLERY_SCREENSHOTS.forEach((screenshotPath, index) => {
    const archivePath = `extension/${screenshotPath}`;
    assertPngBytes(archiveFile(archive, archivePath), archivePath);
    const assetUrl = marketplaceScreenshotUrl(manifest, index);
    if (!readme.includes(`src="${assetUrl}"`)) {
      throw new Error(`Refusing to package because README is missing Marketplace screenshot asset ${screenshotAssetType(index)}`);
    }
    if (GITHUB_RAW_README.test(assetUrl) || !assetUrl.startsWith('https://')) {
      throw new Error('Refusing to package a non-Marketplace screenshot URL');
    }
    const assetTag = screenshotAssetTag(index);
    if (!vsixManifest.includes(assetTag)) {
      throw new Error(`Refusing to package because vsixmanifest is missing Addressable ${screenshotAssetType(index)}`);
    }
  });
}

function packageMarketplaceGallery(archive) {
  const manifest = JSON.parse(archiveFile(archive, 'extension/package.json').toString('utf8'));
  const next = new Map(archive);
  next.set(
    'extension/readme.md',
    Buffer.from(rewritePackagedReadme(archiveFile(archive, 'extension/readme.md').toString('utf8'), manifest), 'utf8')
  );
  next.set(
    'extension.vsixmanifest',
    Buffer.from(addScreenshotAssets(archiveFile(archive, 'extension.vsixmanifest').toString('utf8')), 'utf8')
  );
  assertMarketplaceGalleryPackaging(next);
  return next;
}

async function writeArchive(packagePath, archive) {
  const tempPath = `${packagePath}.${process.pid}.${crypto.randomUUID()}.rewrite.tmp`;
  let created = false;
  try {
    await new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      for (const [name, contents] of [...archive.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        zip.addBuffer(Buffer.from(contents), name);
      }
      zip.end();
      const out = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
      created = true;
      zip.outputStream.pipe(out);
      zip.outputStream.once('error', reject);
      out.once('error', reject);
      out.once('finish', resolve);
    });
    fs.renameSync(tempPath, packagePath);
    created = false;
  } finally {
    if (created) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

async function applyMarketplaceGalleryPackaging(packagePath) {
  const packaged = packageMarketplaceGallery(await readArchive(packagePath));
  await writeArchive(packagePath, packaged);
}

function normalizeReviewedPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error(`Refusing an invalid reviewed package path: ${filePath}`);
  }
  return normalized;
}

function isWithinDirectory(directory, target) {
  const relative = path.relative(directory, target);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function isLinkOrReparsePoint(filePath, stat) {
  if (stat.isSymbolicLink()) {
    return true;
  }
  if (process.platform === 'win32') {
    try {
      fs.readlinkSync(filePath);
      return true;
    } catch {
      // Ordinary files and directories do not have a link target.
    }
  }
  return false;
}

function statIdentity(stat, type = stat.isDirectory() ? 'directory' : 'file') {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: type === 'file' ? stat.size : undefined,
    type
  };
}

function assertSameStatIdentity(before, after, label, options = {}) {
  if (before.type !== after.type || before.mode !== after.mode) {
    throw new Error(`Refusing a changed ${label} identity`);
  }
  if (options.compareSize !== false && before.type === 'file' && before.size !== after.size) {
    throw new Error(`Refusing a changed ${label} identity`);
  }
  if (before.dev && after.dev && before.dev !== after.dev) {
    throw new Error(`Refusing a changed ${label} identity`);
  }
  if (before.ino && after.ino && before.ino !== after.ino) {
    throw new Error(`Refusing a changed ${label} identity`);
  }
}

function assertSafePathComponents(rootRealPath, targetPath, options = {}) {
  const absolutePath = path.resolve(targetPath);
  if (!isWithinDirectory(rootRealPath, absolutePath)) {
    throw new Error(`Refusing a path outside the repository boundary: ${targetPath}`);
  }

  const relative = path.relative(rootRealPath, absolutePath);
  let current = rootRealPath;
  const components = relative ? relative.split(path.sep) : [];
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const isLeaf = index === components.length - 1;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isLeaf && options.allowMissingLeaf && error.code === 'ENOENT') {
        return { absolutePath, canonicalPath: null };
      }
      throw new Error(`Refusing an unavailable path component: ${current}`);
    }
    if (isLinkOrReparsePoint(current, stat)) {
      throw new Error(`Refusing a symlink, junction, or reparse-point path component: ${current}`);
    }
    if ((!isLeaf || options.directory) && !stat.isDirectory()) {
      throw new Error(`Refusing a non-directory path component: ${current}`);
    }
    if (isLeaf && options.regularFile && !stat.isFile()) {
      throw new Error(`Refusing a non-regular file: ${current}`);
    }
  }

  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync.native(absolutePath);
  } catch (error) {
    if (options.allowMissingLeaf && error.code === 'ENOENT') {
      return { absolutePath, canonicalPath: null };
    }
    throw new Error(`Refusing an unresolvable path: ${absolutePath}`);
  }
  if (!isWithinDirectory(rootRealPath, canonicalPath)) {
    throw new Error(`Refusing a path that resolves outside the repository boundary: ${targetPath}`);
  }
  return { absolutePath, canonicalPath };
}

function canonicalRepositoryRoot(root) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(root);
  } catch {
    throw new Error(`Refusing an unresolvable repository root: ${root}`);
  }
  const stat = fs.lstatSync(rootRealPath);
  if (!stat.isDirectory() || isLinkOrReparsePoint(rootRealPath, stat)) {
    throw new Error(`Refusing an unsafe repository root: ${root}`);
  }
  return rootRealPath;
}

function assertNoRawLinkComponents(targetPath) {
  const absolutePath = path.resolve(targetPath);
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (isLinkOrReparsePoint(current, stat)) {
      throw new Error(`Refusing a symlink, junction, or reparse-point path component: ${current}`);
    }
  }
}

function readReviewedSource(rootRealPath, sourcePath, file) {
  assertSafePathComponents(rootRealPath, sourcePath, { regularFile: true });
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`Refusing a non-regular reviewed file: ${file}`);
    }
    // Revalidate after opening. On POSIX O_NOFOLLOW protects the final path;
    // on Windows the component and realpath checks are the available guard.
    assertSafePathComponents(rootRealPath, sourcePath, { regularFile: true });
    const freshStat = fs.statSync(sourcePath);
    assertSameStatIdentity(statIdentity(stat), statIdentity(freshStat), `reviewed file ${file}`);
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Refusing to package because reviewed file is missing: ${file}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function expectedArchiveFiles() {
  return new Set([
    ...GENERATED_ARCHIVE_FILES,
    ...REVIEWED_PACKAGE_FILES.map((file) => `extension/${file === 'LICENSE' ? 'LICENSE.txt' : file === 'README.md' ? 'readme.md' : file === 'CHANGELOG.md' ? 'changelog.md' : file}`)
  ]);
}

function assertReviewedPackageFiles(root) {
  const rootRealPath = canonicalRepositoryRoot(root);
  const normalized = [
    ...REVIEWED_PACKAGE_FILES,
    ...REVIEWED_PACKAGING_CONTROL_FILES
  ].map(normalizeReviewedPath);
  const lowerCasePaths = new Map();
  for (const file of normalized) {
    const lower = file.toLowerCase();
    if (lowerCasePaths.has(lower)) {
      throw new Error(`Refusing a reviewed package allowlist with duplicate paths: ${lowerCasePaths.get(lower)} and ${file}`);
    }
    lowerCasePaths.set(lower, file);

    const sourcePath = path.join(rootRealPath, ...file.split('/'));
    try {
      assertSafePathComponents(rootRealPath, sourcePath, { regularFile: true });
    } catch (error) {
      if (/unavailable path component|unresolvable path/.test(error.message)) {
        throw new Error(`Refusing to package because reviewed file is missing: ${file}`);
      }
      throw error;
    }
  }
  return rootRealPath;
}

function copyReviewedPackage(root, stagingDirectory) {
  const rootRealPath = assertReviewedPackageFiles(root);
  for (const file of [...REVIEWED_PACKAGE_FILES, ...REVIEWED_PACKAGING_CONTROL_FILES]) {
    const sourcePath = path.join(rootRealPath, ...file.split('/'));
    const stagedPath = path.join(stagingDirectory, ...file.split('/'));
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.writeFileSync(stagedPath, readReviewedSource(rootRealPath, sourcePath, file));
  }
}

function assertStagedManifestSafe(stagingDirectory) {
  const manifestPath = path.join(stagingDirectory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.scripts && Object.prototype.hasOwnProperty.call(manifest.scripts, 'vscode:prepublish')) {
    throw new Error('Refusing to package a manifest with scripts.vscode:prepublish; VSCE may execute it with shell access');
  }
}

function assertArchiveMatchesAllowlist(archive) {
  const actual = new Set(archive.keys());
  const expected = expectedArchiveFiles();
  const unexpected = [...actual].filter((file) => !expected.has(file)).sort();
  const missing = [...expected].filter((file) => !actual.has(file)).sort();
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [];
    if (unexpected.length > 0) details.push(`unexpected entries: ${unexpected.join(', ')}`);
    if (missing.length > 0) details.push(`missing reviewed entries: ${missing.join(', ')}`);
    throw new Error(`Refusing to publish a VSIX outside the reviewed allowlist (${details.join('; ')})`);
  }
}

function assertOutputPath(root, outputPath, options = {}) {
  const rootRealPath = canonicalRepositoryRoot(root);
  assertNoRawLinkComponents(outputPath);
  const allowedRoot = options.testOnly
    ? rootRealPath
    : path.join(rootRealPath, 'releases');
  if (!options.testOnly) {
    assertSafePathComponents(rootRealPath, allowedRoot, { directory: true });
  }
  const rawOutput = path.resolve(outputPath);
  let outputParent;
  try {
    outputParent = fs.realpathSync.native(path.dirname(rawOutput));
  } catch {
    throw new Error(`Refusing an unresolvable output parent directory: ${path.dirname(rawOutput)}`);
  }
  // Normalize 8.3 aliases and other filesystem spellings before comparing
  // containment; the final filename may legitimately not exist yet.
  const output = path.join(outputParent, path.basename(rawOutput));
  if (!isWithinDirectory(allowedRoot, output)) {
    throw new Error(`Refusing an output path outside the ${options.testOnly ? 'test root' : 'releases'} boundary: ${outputPath}`);
  }
  assertSafePathComponents(allowedRoot, output, { allowMissingLeaf: true });
  const parentStat = fs.statSync(outputParent);
  return {
    outputPath: output,
    parentPath: outputParent,
    parentIdentity: statIdentity(parentStat),
    rootRealPath
  };
}

function replaceArtifact(candidatePath, outputPath, options = {}) {
  const fsOps = {
    closeSync: fs.closeSync.bind(fs),
    fstatSync: fs.fstatSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    writeSync: fs.writeSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    rmSync: fs.rmSync.bind(fs),
    statSync: fs.statSync.bind(fs),
    ...(options.fsOps || {})
  };
  const outputDirectory = path.dirname(outputPath);
  const temporaryOutput = path.join(
    outputDirectory,
    options.temporaryPath
      ? path.basename(options.temporaryPath)
      : `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  const validateOutput = options.validateOutput || (() => ({
    parentPath: outputDirectory,
    parentIdentity: statIdentity(fsOps.statSync(outputDirectory))
  }));
  const firstValidation = validateOutput();
  let temporaryCreated = false;
  let temporaryIdentity;
  let temporaryDescriptor;
  try {
    // Open the sibling destination exclusively before copying any bytes. This
    // prevents a precreated link/path from being followed and gives cleanup a
    // stable identity for the exact file created by this installer.
    assertNoRawLinkComponents(temporaryOutput);
    temporaryDescriptor = fsOps.openSync(temporaryOutput, 'wx', 0o600);
    temporaryCreated = true;
    const openedTemporaryStat = fsOps.fstatSync(temporaryDescriptor);
    temporaryIdentity = statIdentity(openedTemporaryStat, 'file');
    if (!openedTemporaryStat.isFile()) {
      throw new Error('Refusing an unsafe temporary VSIX destination');
    }
    const temporaryPathStat = fsOps.lstatSync(temporaryOutput);
    if (isLinkOrReparsePoint(temporaryOutput, temporaryPathStat)) {
      throw new Error('Refusing an unsafe temporary VSIX destination');
    }
    assertSameStatIdentity(temporaryIdentity, statIdentity(temporaryPathStat, 'file'), 'temporary VSIX destination');

    const candidateBytes = fsOps.readFileSync(candidatePath);
    let offset = 0;
    while (offset < candidateBytes.length) {
      const written = fsOps.writeSync(temporaryDescriptor, candidateBytes, offset, candidateBytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('Unable to copy the candidate VSIX to its temporary destination');
      }
      offset += written;
    }
    fsOps.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;

    const secondValidation = validateOutput();
    assertSameStatIdentity(firstValidation.parentIdentity, secondValidation.parentIdentity, 'output parent');
    assertNoRawLinkComponents(temporaryOutput);
    const currentTemporaryStat = fsOps.lstatSync(temporaryOutput);
    assertSameStatIdentity(temporaryIdentity, statIdentity(currentTemporaryStat, 'file'), 'temporary VSIX destination', { compareSize: false });
    fsOps.renameSync(temporaryOutput, outputPath);
    temporaryCreated = false;
  } finally {
    if (temporaryDescriptor !== undefined) {
      fsOps.closeSync(temporaryDescriptor);
    }
    if (temporaryCreated) {
      let currentTemporaryStat;
      try {
        currentTemporaryStat = fsOps.lstatSync(temporaryOutput);
      } catch {
        currentTemporaryStat = null;
      }
      if (currentTemporaryStat
        && !isLinkOrReparsePoint(temporaryOutput, currentTemporaryStat)
        && temporaryIdentity
        && (() => {
          try {
            assertSameStatIdentity(temporaryIdentity, statIdentity(currentTemporaryStat, 'file'), 'temporary VSIX destination', { compareSize: false });
            return true;
          } catch {
            return false;
          }
        })()) {
        fsOps.rmSync(temporaryOutput, { force: true });
      }
    }
  }
}

async function packageVsix(root, options = {}) {
  const createCandidate = options.createCandidate || createVSIX;
  const outputPath = options.outputPath || path.join(root, 'releases', 'runlist.vsix');
  const outputOptions = { testOnly: options.testOnly === true };
  assertOutputPath(root, outputPath, outputOptions);
  const installArtifact = options.installArtifact || ((candidatePath, safeOutputPath) => replaceArtifact(
    candidatePath,
    safeOutputPath,
    {
      fsOps: options.fsOps,
      validateOutput: () => assertOutputPath(root, outputPath, outputOptions)
    }
  ));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vsix-package-'));
  const candidatePath = path.join(temporaryDirectory, 'runlist-candidate.vsix');

  try {
    await createReviewedCandidate(root, candidatePath, createCandidate, temporaryDirectory);
    const archive = await readArchive(candidatePath);
    assertArchiveMatchesAllowlist(archive);
    assertMarketplaceGalleryPackaging(archive);
    // Revalidate the destination after packaging and immediately before the
    // install so a replaced parent/output cannot be followed.
    const safeOutput = assertOutputPath(root, outputPath, outputOptions);
    installArtifact(candidatePath, safeOutput.outputPath);
    return { outputPath, files: [...archive.keys()].sort() };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function createReviewedCandidate(root, candidatePath, createCandidate = createVSIX, temporaryDirectory = null) {
  const ownsTemporaryDirectory = !temporaryDirectory;
  const packageDirectory = temporaryDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vsix-package-'));
  const stagingDirectory = path.join(packageDirectory, 'extension');
  fs.mkdirSync(stagingDirectory, { recursive: true });

  try {
    copyReviewedPackage(root, stagingDirectory);
    assertStagedManifestSafe(stagingDirectory);
    await createCandidate({
      cwd: stagingDirectory,
      dependencies: false,
      packageManager: PackageManager.None,
      packagePath: candidatePath,
      // Prevent vsce from rewriting README images to GitHub raw/HEAD. The
      // packaged Details README is then rewritten onto Marketplace gallery
      // screenshot asset URLs, not relative media/ paths.
      rewriteRelativeLinks: false
    });
    await applyMarketplaceGalleryPackaging(candidatePath);
  } finally {
    if (ownsTemporaryDirectory) {
      fs.rmSync(packageDirectory, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  packageVsix(path.join(__dirname, '..'))
    .then(({ outputPath }) => process.stdout.write(`Packaged reviewed VSIX: ${outputPath}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  GALLERY_SCREENSHOTS,
  GENERATED_ARCHIVE_FILES,
  REVIEWED_PACKAGING_CONTROL_FILES,
  REVIEWED_PACKAGE_FILES,
  addScreenshotAssets,
  applyMarketplaceGalleryPackaging,
  assertArchiveMatchesAllowlist,
  assertMarketplaceGalleryPackaging,
  assertOutputPath,
  assertReviewedPackageFiles,
  assertSafePathComponents,
  canonicalRepositoryRoot,
  copyReviewedPackage,
  createReviewedCandidate,
  expectedArchiveFiles,
  marketplaceScreenshotUrl,
  packageMarketplaceGallery,
  packageVsix,
  replaceArtifact,
  rewritePackagedReadme,
  screenshotAssetType
};
