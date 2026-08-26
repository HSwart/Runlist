const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'runlist', 'SKILL.md'), 'utf8');

test('README stack contract claims match shipped review-before-run behavior', () => {
  assert.match(readme, /runlist\.json/);
  assert.match(readme, /\.runlist\/projects\.json/);
  assert.match(readme, /review before commands can run/i);
  assert.match(readme, /keep secrets out of the file/i);
  assert.doesNotMatch(readme, /auto-?apply|auto-?start.*stack|starts? on clone/i);
});

test('agent skill mentions stack load review and no secrets in the file', () => {
  assert.match(skill, /runlist\.json/);
  assert.match(skill, /Load stack from this workspace/);
  assert.match(skill, /review/i);
  assert.match(skill, /secrets/i);
});
