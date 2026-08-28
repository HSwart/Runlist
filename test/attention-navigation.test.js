const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing ${name}`);
  }
  let depth = 0;
  let end = -1;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`Could not extract ${name}`);
  }
  return source.slice(start, end);
}

function loadAttentionHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const context = {
    projectStartFailureText(project) {
      return project.startFailure || '';
    },
    projectStopFailureText(project) {
      return project.stopFailure || '';
    }
  };
  vm.runInNewContext(`
    ${extractFunction(source, 'projectNeedsAttention')}
    ${extractFunction(source, 'projectAttentionIsVisible')}
    ${extractFunction(source, 'attentionIdentityKey')}
    ${extractFunction(source, 'nextAttentionProject')}
    this.projectNeedsAttention = projectNeedsAttention;
    this.nextAttentionProject = nextAttentionProject;
    this.attentionIdentityKey = attentionIdentityKey;
  `, context);
  return context;
}

const helpers = loadAttentionHelpers();

function attentionProject(id, extras = {}) {
  return { id, name: id, status: 'stopped', reviewRequired: true, ...extras };
}

test('nextAttentionProject starts at the first visible attention row and wraps', () => {
  const projects = [
    attentionProject('alpha'),
    attentionProject('beta'),
    attentionProject('gamma'),
    { id: 'idle', name: 'Idle', status: 'stopped' }
  ];
  const isVisible = () => true;

  assert.equal(helpers.nextAttentionProject(projects, '', isVisible).id, 'alpha');
  assert.equal(helpers.nextAttentionProject(projects, 'alpha', isVisible).id, 'beta');
  assert.equal(helpers.nextAttentionProject(projects, 'beta', isVisible).id, 'gamma');
  assert.equal(helpers.nextAttentionProject(projects, 'gamma', isVisible).id, 'alpha');
});

test('nextAttentionProject skips hidden attention rows', () => {
  const projects = [
    attentionProject('alpha'),
    attentionProject('beta'),
    attentionProject('gamma')
  ];
  const isVisible = (project) => project.id !== 'beta';

  assert.equal(helpers.nextAttentionProject(projects, '', isVisible).id, 'alpha');
  assert.equal(helpers.nextAttentionProject(projects, 'alpha', isVisible).id, 'gamma');
  assert.equal(helpers.nextAttentionProject(projects, 'gamma', isVisible).id, 'alpha');
  assert.equal(helpers.nextAttentionProject(projects, 'beta', isVisible).id, 'alpha');
});

test('nextAttentionProject returns undefined when no visible row needs attention', () => {
  const projects = [
    { id: 'idle', name: 'Idle', status: 'stopped' },
    attentionProject('hidden')
  ];
  assert.equal(helpers.nextAttentionProject(projects, 'idle', (project) => project.id === 'idle'), undefined);
  assert.equal(helpers.nextAttentionProject([], 'alpha', () => true), undefined);
});

test('attentionIdentityKey changes when a project is fixed or hidden', () => {
  const projects = [
    attentionProject('alpha'),
    attentionProject('beta'),
    attentionProject('gamma')
  ];
  const allVisible = () => true;
  const hideBeta = (project) => project.id !== 'beta';
  const original = helpers.attentionIdentityKey(projects, allVisible);

  assert.equal(original, 'alpha\nbeta\ngamma');
  assert.equal(helpers.attentionIdentityKey(projects, hideBeta), 'alpha\ngamma');

  const afterFix = [
    attentionProject('alpha'),
    { id: 'beta', name: 'Beta', status: 'stopped' },
    attentionProject('gamma')
  ];
  assert.equal(helpers.attentionIdentityKey(afterFix, allVisible), 'alpha\ngamma');
  assert.notEqual(helpers.attentionIdentityKey(afterFix, allVisible), original);
});
