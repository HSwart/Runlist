const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  classifyProjectRuntime,
  normalizeProjectRuntime,
  runtimeAllowsNpmStartChips
} = require('../src/projects/project-runtime');

function temporaryFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('classifies Azure Functions Python from host.json and worker settings', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, 'host.json'), '{}');
  fs.writeFileSync(path.join(root, 'local.settings.json'), JSON.stringify({
    Values: { FUNCTIONS_WORKER_RUNTIME: 'python' }
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { start: 'echo monorepo root' }
  }));
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'azure-functions\n');

  assert.equal(classifyProjectRuntime(root), 'azure-functions-python');
  assert.equal(runtimeAllowsNpmStartChips('azure-functions-python'), false);
});

test('classifies Azure Functions Python from function_app.py even without settings', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, 'host.json'), '{}');
  fs.writeFileSync(path.join(root, 'function_app.py'), 'import azure.functions\n');

  assert.equal(classifyProjectRuntime(root), 'azure-functions-python');
});

test('classifies Node when package.json scripts are the primary signal', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite' }
  }));
  assert.equal(classifyProjectRuntime(root), 'node');
  assert.equal(runtimeAllowsNpmStartChips('node'), true);
});

test('classifies Python when requirements exist without Node scripts', (t) => {
  const root = temporaryFolder(t);
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'flask\n');
  assert.equal(classifyProjectRuntime(root), 'python');
});

test('normalizes known runtimes and rejects unknown values', () => {
  assert.equal(normalizeProjectRuntime(' Node '), 'node');
  assert.equal(normalizeProjectRuntime(''), undefined);
  assert.throws(() => normalizeProjectRuntime('ruby'), /must be one of/);
});
