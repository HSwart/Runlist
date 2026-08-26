const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('keeps the root entrypoint separate from organized source modules', () => {
  const rootJavaScriptFiles = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
  const sourceDirectories = fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(rootJavaScriptFiles, ['eslint.config.js', 'extension.js']);
  assert.deepEqual(sourceDirectories, [
    'compose',
    'groups',
    'host',
    'integrations',
    'lifecycle',
    'ports',
    'projects',
    'services',
    'webview'
  ]);
  assert.match(
    fs.readFileSync(path.join(root, 'extension.js'), 'utf8'),
    /function activate\(/
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'extension.js'), 'utf8'),
    /class RunlistViewProvider/
  );
  assert.match(
    fs.readFileSync(path.join(root, 'src', 'host', 'runlist-view-provider.js'), 'utf8'),
    /class RunlistViewProvider/
  );
});

test('resolves every static relative import in shipped JavaScript', () => {
  const files = [path.join(root, 'extension.js')];
  collectJavaScriptFiles(path.join(root, 'src'), files);
  collectJavaScriptFiles(path.join(root, 'mcp'), files);
  const missing = [];
  const relativeRequire = /require\(['"](?<target>\.{1,2}\/[^'"]+)['"]\)/g;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(relativeRequire)) {
      const target = path.resolve(path.dirname(file), match.groups.target);
      if (!resolvableModule(target)) {
        missing.push(`${path.relative(root, file)} -> ${match.groups.target}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

function collectJavaScriptFiles(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
}

function resolvableModule(target) {
  return fs.existsSync(target)
    || fs.existsSync(`${target}.js`)
    || fs.existsSync(path.join(target, 'index.js'));
}
