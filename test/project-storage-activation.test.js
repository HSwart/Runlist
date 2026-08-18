const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadExtension(vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode'
      ? vscode
      : originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  try {
    return require('../extension');
  } finally {
    Module._load = originalLoad;
  }
}

test('surfaces unrecoverable storage and stops activation', (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlist-activation-'));
  const projectsFile = path.join(storageRoot, 'projects.json');
  fs.writeFileSync(projectsFile, '{ primary');
  fs.writeFileSync(`${projectsFile}.bak`, '{ backup');
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  const messages = [];
  const extension = loadExtension({
    window: {
      showErrorMessage(message) {
        messages.push(message);
        return Promise.resolve(undefined);
      }
    }
  });
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    globalState: { get: () => [] }
  };

  assert.throws(
    () => extension.activate(context),
    (error) => error.name === 'ProjectStoreError' && error.code === 'UNRECOVERABLE_STORAGE'
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /did not overwrite/i);
  assert.equal(fs.existsSync(path.join(storageRoot, 'mcp')), false);
});
