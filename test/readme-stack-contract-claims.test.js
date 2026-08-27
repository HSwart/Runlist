const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'runlist', 'SKILL.md'), 'utf8');

test('Marketplace README locks the signed listing without the stack-contract essay', () => {
  assert.match(readme, /Start, stop, and switch local apps from one sidebar\./);
  assert.doesNotMatch(readme, /## Everyday use/);
  assert.doesNotMatch(readme, /## Power features/);
  assert.doesNotMatch(readme, /runlist\.json/);
  assert.doesNotMatch(readme, /\.runlist\/projects\.json/);
  assert.doesNotMatch(readme, /review before commands can run/i);
  assert.doesNotMatch(readme, /keep secret values out of the file/i);
  assert.doesNotMatch(readme, /envFile/);
  assert.doesNotMatch(readme, /auto-?apply|auto-?start.*stack|starts? on clone/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(readme, /\/raw\/HEAD\//);
});

test('agent skill mentions stack load review and no secrets in the file', () => {
  assert.match(skill, /runlist\.json/);
  assert.match(skill, /Load stack from this workspace/);
  assert.match(skill, /review/i);
  assert.match(skill, /secret values/i);
  assert.match(skill, /envFile/);
});
