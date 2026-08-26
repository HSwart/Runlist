const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function canonicalFilesystemPath(value) {
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(value);
    }
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function detectWorktreeIdentity(folder, options = {}) {
  if (typeof folder !== 'string' || !folder.trim()) {
    return null;
  }
  let absolute;
  try {
    absolute = canonicalFilesystemPath(folder.trim());
  } catch {
    try {
      absolute = path.resolve(folder.trim());
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }
  }

  const runGit = options.runGit || defaultRunGit;
  let inside;
  try {
    inside = runGit(absolute, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  if (String(inside || '').trim() !== 'true') {
    return null;
  }

  let commonDir;
  let worktreeRoot;
  try {
    commonDir = runGit(absolute, ['rev-parse', '--git-common-dir']);
    worktreeRoot = runGit(absolute, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }

  const normalizedCommon = normalizeGitPath(commonDir, absolute);
  const normalizedRoot = normalizeGitPath(worktreeRoot, absolute);
  if (!normalizedCommon || !normalizedRoot) {
    return null;
  }

  return {
    kind: 'git-worktree',
    commonDir: normalizedCommon,
    worktreeRoot: normalizedRoot,
    id: worktreeIdentityId(normalizedCommon, normalizedRoot)
  };
}

function worktreeIdentityId(commonDir, worktreeRoot) {
  return crypto
    .createHash('sha256')
    .update(`${normalizePathKey(commonDir)}\0${normalizePathKey(worktreeRoot)}`)
    .digest('hex')
    .slice(0, 32);
}

function normalizeGitPath(value, cwd) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(cwd, trimmed);
  return canonicalFilesystemPath(resolved);
}

function normalizePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function defaultRunGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

module.exports = {
  detectWorktreeIdentity,
  worktreeIdentityId
};
