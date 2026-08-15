const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MANAGED_MARKER,
  agentSkillPath,
  agentSkillStatus,
  installAgentSkill
} = require('../skill-installation');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-skill-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function createSource(t) {
  const directory = path.join(temporaryDirectory(t), 'source');
  fs.mkdirSync(path.join(directory, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `${MANAGED_MARKER}\n# Switchboard\n`);
  fs.writeFileSync(path.join(directory, 'agents', 'openai.yaml'), 'interface:\n  display_name: Switchboard\n');
  return directory;
}

test('resolves personal skill folders on macOS and Linux', () => {
  const environment = { HOME: '/Users/example' };
  assert.equal(agentSkillPath('codex', environment, 'darwin'), '/Users/example/.codex/skills/switchboard');
  assert.equal(agentSkillPath('claude', environment, 'darwin'), '/Users/example/.claude/skills/switchboard');
  assert.equal(agentSkillPath('copilot', environment, 'linux'), '/Users/example/.copilot/skills/switchboard');
  assert.equal(
    agentSkillPath('codex', { ...environment, CODEX_HOME: '/opt/codex' }, 'linux'),
    '/opt/codex/skills/switchboard'
  );
});

test('resolves personal skill folders on Windows', () => {
  const environment = { USERPROFILE: 'C:\\Users\\example' };
  assert.equal(agentSkillPath('codex', environment, 'win32'), 'C:\\Users\\example\\.codex\\skills\\switchboard');
  assert.equal(agentSkillPath('claude', environment, 'win32'), 'C:\\Users\\example\\.claude\\skills\\switchboard');
  assert.equal(agentSkillPath('copilot', environment, 'win32'), 'C:\\Users\\example\\.copilot\\skills\\switchboard');
});

test('installs and refreshes the managed skill for every supported agent', (t) => {
  const home = temporaryDirectory(t);
  const sourceDirectory = createSource(t);

  for (const agent of ['copilot', 'codex', 'claude']) {
    const options = {
      agent,
      environment: { HOME: home },
      platform: 'darwin',
      sourceDirectory
    };
    const installed = installAgentSkill(options);
    assert.equal(agentSkillStatus(options).status, 'installed');
    assert.match(fs.readFileSync(path.join(installed.targetDirectory, 'SKILL.md'), 'utf8'), /# Switchboard/);
    assert.ok(fs.existsSync(path.join(installed.targetDirectory, 'agents', 'openai.yaml')));

    fs.writeFileSync(path.join(installed.targetDirectory, 'SKILL.md'), `${MANAGED_MARKER}\nold content\n`);
    installAgentSkill(options);
    assert.doesNotMatch(fs.readFileSync(path.join(installed.targetDirectory, 'SKILL.md'), 'utf8'), /old content/);
  }
});

test('does not overwrite an existing user-owned skill', (t) => {
  const home = temporaryDirectory(t);
  const sourceDirectory = createSource(t);
  const targetDirectory = agentSkillPath('codex', { HOME: home }, 'darwin');
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(path.join(targetDirectory, 'SKILL.md'), '# My own skill\n');

  assert.throws(
    () => installAgentSkill({
      agent: 'codex',
      environment: { HOME: home },
      platform: 'darwin',
      sourceDirectory
    }),
    (error) => error.code === 'ESKILLCONFLICT'
  );
  assert.equal(fs.readFileSync(path.join(targetDirectory, 'SKILL.md'), 'utf8'), '# My own skill\n');
});

test('does not follow an existing skill-directory symlink', (t) => {
  const home = temporaryDirectory(t);
  const sourceDirectory = createSource(t);
  const outsideDirectory = path.join(temporaryDirectory(t), 'outside');
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(path.join(outsideDirectory, 'SKILL.md'), `${MANAGED_MARKER}\nprotected\n`);
  const targetDirectory = agentSkillPath('claude', { HOME: home }, 'darwin');
  fs.mkdirSync(path.dirname(targetDirectory), { recursive: true });
  fs.symlinkSync(outsideDirectory, targetDirectory, 'dir');

  assert.throws(
    () => installAgentSkill({
      agent: 'claude',
      environment: { HOME: home },
      platform: 'darwin',
      sourceDirectory
    }),
    (error) => error.code === 'ESKILLCONFLICT'
  );
  assert.match(fs.readFileSync(path.join(outsideDirectory, 'SKILL.md'), 'utf8'), /protected/);
});
