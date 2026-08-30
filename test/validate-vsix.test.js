const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { archiveContentMismatches, readArchive, validateSourcePackaging, validateVsix } = require('../scripts/validate-vsix');

const root = path.join(__dirname, '..');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const { name, contents } = entry;
    const nameBuffer = entry.nameBytes ? Buffer.from(entry.nameBytes) : Buffer.from(name, 'utf8');
    const flags = entry.flags ?? (entry.nameBytes ? 0 : 0x800);
    const extra = entry.extra || Buffer.alloc(0);
    const contentBuffer = Buffer.from(contents);
    const crc = crc32(contentBuffer);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(extra.length, 28);
    localParts.push(localHeader, nameBuffer, extra, contentBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(extra.length, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer, extra);

    offset += localHeader.length + nameBuffer.length + extra.length + contentBuffer.length;
  }

  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralData.length, 12);
  endRecord.writeUInt32LE(localData.length, 16);

  return Buffer.concat([localData, centralData, endRecord]);
}

function extraField(id, data) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function unicodePathExtra(rawName, unicodeName, nameCrc = crc32(rawName)) {
  const unicodeNameBuffer = Buffer.from(unicodeName, 'utf8');
  const data = Buffer.alloc(5 + unicodeNameBuffer.length);
  data.writeUInt8(1, 0);
  data.writeUInt32LE(nameCrc, 1);
  unicodeNameBuffer.copy(data, 5);
  return extraField(0x7075, data);
}

function temporaryArchive(t, entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vsix-entry-names-'));
  const archivePath = path.join(directory, 'fixture.vsix');
  fs.writeFileSync(archivePath, createZip(entries));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return archivePath;
}

function temporaryFixtureRoot(t, reviewedEntries, candidateEntries) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vsix-casing-'));
  const releasesDirectory = path.join(fixtureRoot, 'releases');
  fs.mkdirSync(releasesDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fixtureRoot, 'package.json'));
  const candidateFixture = path.join(fixtureRoot, 'candidate.vsix');
  fs.writeFileSync(
    path.join(releasesDirectory, 'runlist.vsix'),
    createZip(reviewedEntries)
  );
  fs.writeFileSync(candidateFixture, createZip(candidateEntries));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  return { fixtureRoot, candidateFixture };
}

function fixtureDependencies(candidateFixture) {
  const manifest = require('../package.json');
  return {
    readPackage: async () => ({ manifest }),
    createCandidate: async ({ packagePath }) => fs.copyFileSync(candidateFixture, packagePath)
  };
}

test('accepts the reviewed VSIX only when identity, version, and contents match', async (t) => {
  const { fixtureRoot, candidateFixture } = temporaryFixtureRoot(
    t,
    [{ name: 'extension/skills/runlist/SKILL.md', contents: '# Runlist\n' }],
    [{ name: 'extension/skills/runlist/SKILL.md', contents: '# Runlist\n' }]
  );

  await assert.doesNotReject(validateVsix(fixtureRoot, fixtureDependencies(candidateFixture)));
});

test('accepts current source packaging without requiring the tracked VSIX to match', async () => {
  await assert.doesNotReject(validateSourcePackaging(root));
});

test('refuses to publish a stale VSIX', async () => {
  const manifest = require('../package.json');
  const staleVersion = '0.0.0';

  await assert.rejects(
    validateVsix(root, async () => ({ manifest: { ...manifest, version: staleVersion } })),
    (error) => {
      assert.match(error.message, /Refusing to publish a stale or incorrect VSIX/);
      assert.match(error.message, new RegExp(`version is ${staleVersion.replaceAll('.', '\\.')}`));
      assert.match(error.message, new RegExp(`but ${manifest.version.replaceAll('.', '\\.')} in package\\.json`));
      return true;
    }
  );
});

test('detects changed shipped files even when the manifest identity still matches', () => {
  const reviewed = new Map([
    ['extension/package.json', Buffer.from('{"version":"0.0.8"}')],
    ['extension/src/projects/project-tags.js', Buffer.from('old implementation')]
  ]);
  const candidate = new Map([
    ['extension/package.json', Buffer.from('{"version":"0.0.8"}')],
    ['extension/src/projects/project-tags.js', Buffer.from('current implementation')]
  ]);

  assert.deepEqual(archiveContentMismatches(reviewed, candidate), [
    'extension/src/projects/project-tags.js differs'
  ]);
});

test('does not treat platform line endings as changed shipped content', () => {
  assert.deepEqual(archiveContentMismatches(
    new Map([['extension/extension.js', Buffer.from('const value = 1;\n')]]),
    new Map([['extension/extension.js', Buffer.from('const value = 1;\r\n')]])
  ), []);
});

test('decodes non-UTF8 archive names as CP437 like the content reader', async (t) => {
  const rawName = Buffer.concat([
    Buffer.from('extension/caf', 'ascii'),
    Buffer.from([0x82]),
    Buffer.from('.txt', 'ascii')
  ]);
  const archive = await readArchive(temporaryArchive(t, [
    { nameBytes: rawName, contents: 'cafe' }
  ]));

  assert.deepEqual([...archive.keys()], ['extension/café.txt']);
});

test('uses a valid Info-ZIP Unicode Path extra field', async (t) => {
  const rawName = Buffer.from('extension/legacy.txt', 'ascii');
  const archive = await readArchive(temporaryArchive(t, [
    {
      nameBytes: rawName,
      extra: unicodePathExtra(rawName, 'extension/naïve.txt'),
      contents: 'unicode'
    }
  ]));

  assert.deepEqual([...archive.keys()], ['extension/naïve.txt']);
});

test('falls back to CP437 when a Unicode Path extra field has an invalid CRC', async (t) => {
  const rawName = Buffer.concat([
    Buffer.from('extension/caf', 'ascii'),
    Buffer.from([0x82]),
    Buffer.from('.txt', 'ascii')
  ]);
  const archive = await readArchive(temporaryArchive(t, [
    {
      nameBytes: rawName,
      extra: unicodePathExtra(rawName, 'extension/incorrect.txt', 0x12345678),
      contents: 'fallback'
    }
  ]));

  assert.deepEqual([...archive.keys()], ['extension/café.txt']);
});

test('honors the general-purpose UTF-8 filename flag', async (t) => {
  const archive = await readArchive(temporaryArchive(t, [
    {
      nameBytes: Buffer.from('extension/naïve.txt', 'utf8'),
      flags: 0x800,
      contents: 'utf8'
    }
  ]));

  assert.deepEqual([...archive.keys()], ['extension/naïve.txt']);
});

test('normalizes backslashes in archive names like the content reader', async (t) => {
  const archive = await readArchive(temporaryArchive(t, [
    {
      nameBytes: Buffer.from('extension\\skills\\runlist\\SKILL.md', 'utf8'),
      flags: 0x800,
      contents: '# Runlist\n'
    }
  ]));

  assert.deepEqual([...archive.keys()], ['extension/skills/runlist/SKILL.md']);
});

test('rejects an archive with a truncated extra-field record', async (t) => {
  await assert.rejects(
    readArchive(temporaryArchive(t, [
      {
        name: 'extension/file.txt',
        extra: Buffer.from([0xaa]),
        contents: 'invalid extra field'
      }
    ])),
    /malformed|truncated extra field/i
  );
});

test('rejects a reviewed VSIX whose required skill path has the wrong casing', async (t) => {
  const contents = '# Runlist\n';
  const { fixtureRoot, candidateFixture } = temporaryFixtureRoot(
    t,
    [{ name: 'extension/skills/runlist/skill.md', contents }],
    [{ name: 'extension/skills/runlist/SKILL.md', contents }]
  );

  await assert.rejects(
    validateVsix(fixtureRoot, fixtureDependencies(candidateFixture)),
    (error) => {
      assert.match(error.message, /packaged contents do not match current source/);
      assert.match(error.message, /SKILL\.md/);
      assert.match(error.message, /skill\.md/);
      return true;
    }
  );
});

test('accepts a correctly cased required skill path', async (t) => {
  const { fixtureRoot, candidateFixture } = temporaryFixtureRoot(
    t,
    [{ name: 'extension/skills/runlist/SKILL.md', contents: '# Runlist\n' }],
    [{ name: 'extension/skills/runlist/SKILL.md', contents: '# Runlist\n' }]
  );

  await assert.doesNotReject(validateVsix(fixtureRoot, fixtureDependencies(candidateFixture)));
});

test('rejects duplicate case-variant archive entries', async (t) => {
  const { fixtureRoot, candidateFixture } = temporaryFixtureRoot(
    t,
    [
      { name: 'extension/skills/runlist/SKILL.md', contents: '# Runlist\n' },
      { name: 'extension/skills/runlist/skill.md', contents: '# Runlist\n' }
    ],
    [{ name: 'extension/skills/runlist/SKILL.md', contents: '# Runlist\n' }]
  );

  await assert.rejects(
    validateVsix(fixtureRoot, fixtureDependencies(candidateFixture)),
    (error) => {
      assert.match(error.message, /duplicate case-insensitive archive entries/i);
      assert.match(error.message, /SKILL\.md/);
      assert.match(error.message, /skill\.md/);
      return true;
    }
  );
});
