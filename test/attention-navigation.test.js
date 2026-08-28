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
    ${extractFunction(source, 'attentionVisibility')}
    ${extractFunction(source, 'attentionButtonLabel')}
    ${extractFunction(source, 'attentionButtonAriaLabel')}
    this.projectNeedsAttention = projectNeedsAttention;
    this.nextAttentionProject = nextAttentionProject;
    this.attentionIdentityKey = attentionIdentityKey;
    this.attentionVisibility = attentionVisibility;
    this.attentionButtonLabel = attentionButtonLabel;
    this.attentionButtonAriaLabel = attentionButtonAriaLabel;
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

test('attentionVisibility reports hidden attention rows separately from the total count', () => {
  const projects = [
    attentionProject('alpha'),
    attentionProject('beta'),
    attentionProject('gamma'),
    { id: 'idle', name: 'Idle', status: 'stopped' }
  ];
  const hideBetaAndGamma = (project) => project.id === 'alpha' || project.id === 'idle';

  const allVisible = helpers.attentionVisibility(projects, () => true);
  assert.equal(allVisible.total, 3);
  assert.equal(allVisible.visible, 3);
  assert.equal(allVisible.hidden, 0);

  const partiallyHidden = helpers.attentionVisibility(projects, hideBetaAndGamma);
  assert.equal(partiallyHidden.total, 3);
  assert.equal(partiallyHidden.visible, 1);
  assert.equal(partiallyHidden.hidden, 2);

  const allHidden = helpers.attentionVisibility(projects, (project) => project.id === 'idle');
  assert.equal(allHidden.total, 3);
  assert.equal(allHidden.visible, 0);
  assert.equal(allHidden.hidden, 3);
});

test('attention button copy keeps the total count and describes hidden rows in the accessible name', () => {
  assert.equal(helpers.attentionButtonLabel(1), 'Needs attention');
  assert.equal(helpers.attentionButtonLabel(3), 'Needs attention (3)');
  assert.equal(
    helpers.attentionButtonAriaLabel({ total: 1, visible: 1, hidden: 0 }),
    'Focus first project that needs attention'
  );
  assert.equal(
    helpers.attentionButtonAriaLabel({ total: 3, visible: 3, hidden: 0 }),
    'Show next project that needs attention, 3 total'
  );
  assert.equal(
    helpers.attentionButtonAriaLabel({ total: 3, visible: 1, hidden: 2 }),
    'Show next project that needs attention, 1 of 3 visible, 2 hidden by filters'
  );
  assert.equal(
    helpers.attentionButtonAriaLabel({ total: 2, visible: 0, hidden: 2 }),
    'Show next project that needs attention, 0 of 2 visible, 2 hidden by filters'
  );
});
