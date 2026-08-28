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

test('projectNeedsAttention includes running-elsewhere rows that still need a stop command', () => {
  assert.equal(helpers.projectNeedsAttention({
    id: 'elsewhere',
    name: 'Elsewhere',
    status: 'active'
  }), true);
  assert.equal(helpers.projectNeedsAttention({
    id: 'elsewhere-empty',
    name: 'Elsewhere empty',
    status: 'active',
    stopCommand: ''
  }), true);
  assert.equal(helpers.projectNeedsAttention({
    id: 'elsewhere-blank',
    name: 'Elsewhere blank',
    status: 'active',
    stopCommand: '   '
  }), true);
});

test('projectNeedsAttention includes ownership-lost rows that still need a stop command', () => {
  assert.equal(helpers.projectNeedsAttention({
    id: 'lost',
    name: 'Lost',
    status: 'ownership-lost'
  }), true);
  assert.equal(helpers.projectNeedsAttention({
    id: 'lost-empty',
    name: 'Lost empty',
    status: 'ownership-lost',
    stopCommand: ''
  }), true);
});

test('projectNeedsAttention does not include detected rows that already have a stop command', () => {
  assert.equal(helpers.projectNeedsAttention({
    id: 'detected',
    name: 'Detected',
    status: 'active',
    stopCommand: 'docker compose down'
  }), false);
});

test('projectNeedsAttention still counts an unresponsive detected row once', () => {
  const project = {
    id: 'unresponsive',
    name: 'Unresponsive',
    status: 'active',
    httpUnresponsive: true
  };
  assert.equal(helpers.projectNeedsAttention(project), true);
  assert.equal(helpers.projectNeedsAttention({
    ...project,
    stopCommand: 'docker compose down'
  }), true);
  assert.equal(
    helpers.attentionIdentityKey([
      project,
      { id: 'idle', name: 'Idle', status: 'stopped' }
    ], () => true),
    'unresponsive'
  );
});

test('projectNeedsAttention does not double-count stop-failure or review rows', () => {
  const stopFailure = {
    id: 'stop-fail',
    name: 'Stop fail',
    status: 'active',
    stopFailure: 'Port :3000 is still up'
  };
  const reviewRequired = {
    id: 'review',
    name: 'Review',
    status: 'active',
    reviewRequired: true
  };
  assert.equal(helpers.projectNeedsAttention(stopFailure), true);
  assert.equal(helpers.projectNeedsAttention(reviewRequired), true);
  assert.equal(
    helpers.attentionIdentityKey([stopFailure, reviewRequired], () => true),
    'stop-fail\nreview'
  );
});

test('attentionIdentityKey drops a running-elsewhere row after a stop command is saved', () => {
  const before = [{
    id: 'elsewhere',
    name: 'Elsewhere',
    status: 'active',
    stopCommand: ''
  }];
  const after = [{
    ...before[0],
    stopCommand: 'docker compose down'
  }];
  const allVisible = () => true;

  assert.equal(helpers.attentionIdentityKey(before, allVisible), 'elsewhere');
  assert.equal(helpers.attentionIdentityKey(after, allVisible), '');
  assert.equal(helpers.nextAttentionProject(after, 'elsewhere', allVisible), undefined);
});
