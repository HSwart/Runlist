const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVSIX, PackageManager } = require('@vscode/vsce');
const { readVSIXPackage, readZip } = require('@vscode/vsce/out/zip');

const TEXT_ARCHIVE_PATH = /(?:\.(?:css|js|json|md|svg|txt|ya?ml|xml)|vsixmanifest)$/i;
const CP437 = String.fromCodePoint(...[0, 9786, 9787, 9829, 9830, 9827, 9824, 8226, 9688, 9675, 9689, 9794, 9792, 9834, 9835, 9788, 9658, 9668, 8597, 8252, 182, 167, 9644, 8616, 8593, 8595, 8594, 8592, 8735, 8596, 9650, 9660, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 8962, 199, 252, 233, 226, 228, 224, 229, 231, 234, 235, 232, 239, 238, 236, 196, 197, 201, 230, 198, 244, 246, 242, 251, 249, 255, 214, 220, 162, 163, 165, 8359, 402, 225, 237, 243, 250, 241, 209, 170, 186, 191, 8976, 172, 189, 188, 161, 171, 187, 9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558, 9557, 9571, 9553, 9559, 9565, 9564, 9563, 9488, 9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567, 9562, 9556, 9577, 9574, 9568, 9552, 9580, 9575, 9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579, 9578, 9496, 9484, 9608, 9604, 9612, 9616, 9600, 945, 223, 915, 960, 931, 963, 181, 964, 934, 920, 937, 948, 8734, 966, 949, 8745, 8801, 177, 8805, 8804, 8992, 8993, 247, 8776, 176, 8729, 183, 8730, 8319, 178, 9632, 160]);

function archiveContentsEqual(archivePath, reviewed, candidate) {
  if (!TEXT_ARCHIVE_PATH.test(archivePath)) {
    return reviewed.equals(candidate);
  }
  return reviewed.toString('utf8').replaceAll('\r\n', '\n')
    === candidate.toString('utf8').replaceAll('\r\n', '\n');
}

function archiveContentMismatches(reviewed, candidate) {
  const paths = [...new Set([...reviewed.keys(), ...candidate.keys()])].sort();
  return paths.flatMap((archivePath) => {
    const reviewedContent = reviewed.get(archivePath);
    const candidateContent = candidate.get(archivePath);
    if (!reviewedContent) {
      return [`${archivePath} is missing from the reviewed VSIX`];
    }
    if (!candidateContent) {
      return [`${archivePath} is not shipped by the current source`];
    }
    return archiveContentsEqual(archivePath, reviewedContent, candidateContent)
      ? []
      : [`${archivePath} differs`];
  });
}

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

function decodeCp437(buffer) {
  let result = '';
  for (const byte of buffer) {
    result += CP437[byte];
  }
  return result;
}

function parseArchiveExtraFields(extra) {
  const fields = [];
  let offset = 0;
  while (offset < extra.length) {
    if (extra.length - offset < 4) {
      throw new Error('Unable to read VSIX archive entry names: malformed or truncated extra field');
    }
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > extra.length) {
      throw new Error('Unable to read VSIX archive entry names: malformed or truncated extra field');
    }
    fields.push({ id, data: extra.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return fields;
}

function decodeArchiveEntryName(rawName, flags, extraFields) {
  for (const field of extraFields) {
    if (field.id !== 0x7075 || field.data.length < 6 || field.data.readUInt8(0) !== 1) {
      continue;
    }
    if (crc32(rawName) !== field.data.readUInt32LE(1)) {
      continue;
    }
    return field.data.subarray(5).toString('utf8').replaceAll('\\', '/');
  }
  const name = (flags & 0x800) !== 0
    ? rawName.toString('utf8')
    : decodeCp437(rawName);
  return name.replaceAll('\\', '/');
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) {
      continue;
    }
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength <= archive.length) {
      return offset;
    }
  }
  throw new Error('Unable to read VSIX archive entry names: end of central directory not found');
}

function archiveEntryNames(archive) {
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  if (
    entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('Unable to read VSIX archive entry names: ZIP64 archives are not supported');
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > endOffset || centralDirectoryOffset < 0) {
    throw new Error('Unable to read VSIX archive entry names: invalid central directory');
  }

  const names = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Unable to read VSIX archive entry names: invalid central directory entry');
    }
    const flags = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    const entryEnd = nameEnd + extraLength + commentLength;
    if (entryEnd > centralDirectoryEnd) {
      throw new Error('Unable to read VSIX archive entry names: truncated central directory entry');
    }
    const rawName = archive.subarray(nameStart, nameEnd);
    const extraFields = parseArchiveExtraFields(archive.subarray(nameEnd, extraEnd));
    names.push(decodeArchiveEntryName(rawName, flags, extraFields));
    offset = entryEnd;
  }
  return names;
}

async function readArchive(packagePath) {
  const [contents, archive] = await Promise.all([
    readZip(packagePath, () => true),
    fs.promises.readFile(packagePath)
  ]);
  const names = archiveEntryNames(archive);
  const result = new Map();
  const normalizedNames = new Map();
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      const previousName = normalizedNames.get(normalizedName);
      throw new Error(
        `Refusing to publish a VSIX with duplicate case-insensitive archive entries: ${previousName} and ${name}`
      );
    }
    normalizedNames.set(normalizedName, name);
    const content = contents.get(normalizedName);
    if (!content) {
      throw new Error(`Unable to read VSIX archive entry contents for ${name}`);
    }
    result.set(name, content);
  }
  return result;
}

async function validateVsix(root, dependencies = {}) {
  const readPackage = typeof dependencies === 'function'
    ? dependencies
    : dependencies.readPackage || readVSIXPackage;
  const createCandidate = dependencies.createCandidate || (async ({ packagePath }) => {
    const { createReviewedCandidate } = require('./package-vsix');
    await createReviewedCandidate(root, packagePath);
  });
  const readArchiveContents = dependencies.readArchive || readArchive;
  const expected = require(path.join(root, 'package.json'));
  const reviewedPath = path.join(root, 'releases', 'runlist.vsix');
  const { manifest: actual } = await readPackage(reviewedPath);
  const mismatches = [];

  for (const field of ['publisher', 'name', 'version']) {
    if (actual[field] !== expected[field]) {
      mismatches.push(`${field} is ${actual[field]} in the VSIX but ${expected[field]} in package.json`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Refusing to publish a stale or incorrect VSIX: ${mismatches.join('; ')}. Run npm run package and review the new package first.`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-vsix-validation-'));
  const candidatePath = path.join(temporaryDirectory, 'runlist-candidate.vsix');
  try {
    await createCandidate({
      cwd: root,
      packageManager: PackageManager.None,
      packagePath: candidatePath
    });
    const [reviewed, candidate] = await Promise.all([
      readArchiveContents(reviewedPath),
      readArchiveContents(candidatePath)
    ]);
    const contentMismatches = archiveContentMismatches(reviewed, candidate);
    if (contentMismatches.length > 0) {
      const shown = contentMismatches.slice(0, 10);
      const remaining = contentMismatches.length - shown.length;
      throw new Error(
        `Refusing to publish a stale or incorrect VSIX: packaged contents do not match current source (${shown.join('; ')}${remaining > 0 ? `; and ${remaining} more` : ''}). Run npm run package and review the new package first.`
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  validateVsix(path.join(__dirname, '..'))
    .then(() => process.stdout.write('Marketplace VSIX identity, version, and packaged contents match current source.\n'))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { archiveContentMismatches, readArchive, validateVsix };
