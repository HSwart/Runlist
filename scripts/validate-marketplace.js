const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER_PUBLISHER = 'local';
const ALLOWED_CATEGORIES = new Set([
  'Programming Languages',
  'Snippets',
  'Linters',
  'Themes',
  'Debuggers',
  'Formatters',
  'Keymaps',
  'SCM Providers',
  'Other',
  'Extension Packs',
  'Language Packs',
  'Data Science',
  'Machine Learning',
  'Visualization',
  'Notebooks',
  'Education',
  'Testing'
]);

function readPngDimensions(filePath) {
  const image = fs.readFileSync(filePath);
  if (image.length < 24 || image.subarray(1, 4).toString('ascii') !== 'PNG') {
    return null;
  }
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20)
  };
}

function validateMarketplace(root, options = {}) {
  const errors = [];
  const warnings = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const releaseGuide = fs.readFileSync(path.join(root, 'docs', 'marketplace-release.md'), 'utf8');
  const vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');

  for (const field of ['name', 'displayName', 'description', 'version', 'publisher']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`package.json ${field} must be a non-empty string`);
    }
  }

  if (manifest.publisher === PLACEHOLDER_PUBLISHER) {
    const message = 'choose the permanent Marketplace publisher identifier and replace package.json publisher';
    if (options.preparation) {
      warnings.push(message);
    } else {
      errors.push(message);
    }
  } else if (!/^[a-z0-9][a-z0-9-]*$/i.test(manifest.publisher || '')) {
    errors.push('package.json publisher must be a valid Marketplace identifier');
  }

  if (manifest.license !== 'SEE LICENSE IN LICENSE') {
    errors.push('package.json license must link to the shipped LICENSE file');
  }
  if (manifest.pricing !== 'Free') {
    errors.push('package.json pricing must match the free distribution model');
  }
  if (manifest.markdown !== 'github') {
    errors.push('package.json markdown must match the GitHub-authored README');
  }
  if (!manifest.galleryBanner || !/^#[0-9A-F]{6}$/i.test(manifest.galleryBanner.color || '')) {
    errors.push('package.json galleryBanner must include a six-digit hex color');
  }
  if (!manifest.galleryBanner || !['dark', 'light'].includes(manifest.galleryBanner.theme)) {
    errors.push('package.json galleryBanner must use a supported text theme');
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0 || manifest.keywords.length > 30) {
    errors.push('package.json keywords must contain between 1 and 30 entries');
  }
  if (!Array.isArray(manifest.categories) || manifest.categories.some((category) => !ALLOWED_CATEGORIES.has(category))) {
    errors.push('package.json categories must use Marketplace-supported values');
  }

  const requiredUrls = [
    ['repository.url', manifest.repository && manifest.repository.url],
    ['homepage', manifest.homepage],
    ['bugs.url', manifest.bugs && manifest.bugs.url]
  ];
  for (const [field, value] of requiredUrls) {
    if (typeof value !== 'string' || !value.startsWith('https://')) {
      errors.push(`package.json ${field} must be an HTTPS URL`);
    }
  }

  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) {
    if (!fs.existsSync(path.join(root, file))) {
      errors.push(`${file} must be present`);
    }
  }

  const iconPath = path.join(root, manifest.icon || '');
  const iconDimensions = fs.existsSync(iconPath) ? readPngDimensions(iconPath) : null;
  if (!iconDimensions || iconDimensions.width < 128 || iconDimensions.height < 128) {
    errors.push('package.json icon must reference a PNG that is at least 128x128');
  }

  if (readme.includes('github.com/HSwart/Runlist/releases/download/')) {
    errors.push('README.md must use Marketplace installation instead of a direct VSIX download');
  }
  const marketplaceUrl = `https://marketplace.visualstudio.com/items?itemName=${manifest.publisher}.${manifest.name}`;
  if (!readme.includes(`Install from the [VS Code Marketplace](${marketplaceUrl}).`)) {
    errors.push('README.md must explain how to install from the VS Code Marketplace');
  }
  const marketplaceLinks = readme.match(/https:\/\/marketplace\.visualstudio\.com\/items\?itemName=[^)"<\s]+/g) || [];
  if (marketplaceLinks.length === 0 || marketplaceLinks.some((link) => link !== marketplaceUrl)) {
    errors.push('README.md Marketplace links must use the manifest publisher and extension name');
  }
  if (!security.includes(`| ${manifest.version} | Yes |`)) {
    errors.push('SECURITY.md must mark the manifest version as supported');
  }
  if (!changelog.includes(`## ${manifest.version}`)) {
    errors.push('CHANGELOG.md must include the manifest version');
  }
  if (!changelog.includes('optional custom stop command')) {
    errors.push('CHANGELOG.md must describe the current optional custom stop command');
  }
  if (changelog.includes('## Unreleased')) {
    const message = 'assign a new release version and move CHANGELOG.md Unreleased notes before publishing';
    if (options.preparation) {
      warnings.push(message);
    } else {
      errors.push(message);
    }
  }
  if (!releaseGuide.includes('vsce publish --azure-credential --packagePath releases/runlist.vsix')) {
    errors.push('Marketplace release guide must publish the exact reviewed VSIX');
  }
  if (manifest.scripts?.['publish:marketplace'] !== 'npm run validate:marketplace:publish && npm run validate:marketplace:vsix && vsce publish --azure-credential --packagePath releases/runlist.vsix') {
    errors.push('Marketplace publish command must validate and publish only the reviewed VSIX with Microsoft Entra ID');
  }

  for (const pattern of ['.env*', '.agents/**', 'AGENTS.md', 'docs/**', 'scripts/**', 'test/**', 'media/runlist-screenshot.png']) {
    if (!vscodeIgnore.split(/\r?\n/).includes(pattern)) {
      errors.push(`.vscodeignore must exclude ${pattern}`);
    }
  }

  return { errors, warnings };
}

if (require.main === module) {
  const preparation = process.argv.includes('--preparation');
  const result = validateMarketplace(path.join(__dirname, '..'), { preparation });

  for (const warning of result.warnings) {
    process.stderr.write(`Marketplace readiness warning: ${warning}\n`);
  }
  for (const error of result.errors) {
    process.stderr.write(`Marketplace readiness error: ${error}\n`);
  }

  if (result.errors.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write('Marketplace metadata validation passed.\n');
  }
}

module.exports = {
  PLACEHOLDER_PUBLISHER,
  readPngDimensions,
  validateMarketplace
};
