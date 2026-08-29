const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const webview = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

function renderAttentionNavigationHarness(projects, {
  persistedWebviewState = {},
  hiddenProjectIds = []
} = {}) {
  const savedStates = [];
  const elements = new Map();
  const projectRows = [];
  const runButtons = [];
  const inertElement = () => ({
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
    scrollIntoView() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
    style: { removeProperty() {}, setProperty() {} }
  });

  for (const project of projects) {
    const row = inertElement();
    row.dataset = { projectId: String(project.id) };
    row.hidden = hiddenProjectIds.includes(String(project.id));
    projectRows.push(row);
    const button = inertElement();
    button.dataset = { id: String(project.id) };
    runButtons.push(button);
  }

  const attentionFocusStatus = inertElement();
  elements.set('attention-focus-status', attentionFocusStatus);
  elements.set('app', inertElement());
  elements.set('project-search', inertElement());
  elements.set('project-count', inertElement());
  elements.set('summary-status', inertElement());
  elements.set('project-search-status', inertElement());
  elements.set('project-lifecycle-status', inertElement());

  const document = {
    activeElement: undefined,
    addEventListener() {},
    getElementById(id) {
      return elements.get(id);
    },
    querySelector(selector) {
      const projectId = selector.match(/data-project-id="([^"]*)"/)?.[1]
        || selector.match(/data-id="([^"]*)"/)?.[1];
      if (selector.includes('.project-row')) {
        return projectRows.find((row) => row.dataset.projectId === projectId);
      }
      if (selector.includes('.run-button')) {
        return runButtons.find((button) => button.dataset.id === projectId);
      }
      return undefined;
    },
    querySelectorAll(selector) {
      if (selector === '.project-row') {
        return projectRows;
      }
      return [];
    }
  };

  const context = {
    CSS: { escape: String },
    Map,
    Set,
    URL,
    acquireVsCodeApi() {
      return {
        getState() {
          return persistedWebviewState;
        },
        postMessage() {},
        setState(nextState) {
          savedStates.push(JSON.parse(JSON.stringify(nextState)));
        }
      };
    },
    cancelAnimationFrame() {},
    clearInterval() {},
    clearTimeout() {},
    document,
    requestAnimationFrame() { return 1; },
    setInterval() { return 1; },
    setTimeout() { return 1; },
    window: {
      RunlistMessageRouter: {
        createWebviewMessageRouter() {
          return () => false;
        }
      },
      RunlistProjectActions: require('../media/project-actions'),
      RunlistProjectStatus: require('../media/project-status-display'),
      addEventListener() {},
      runlistState: {
        focusTarget: undefined,
        mode: 'list',
        projects,
        runningAppIds: [],
        searchQuery: '',
        stopAllCount: 0,
        tagFilter: ''
      }
    }
  };

  vm.runInNewContext(webview, context, { filename: 'media/main.js' });
  return {
    attentionFocusStatus,
    evaluate(source) {
      return vm.runInNewContext(source, context);
    },
    runButtons,
    savedStates
  };
}

test('shows Needs attention count in label and aria-label when multiple rows need attention', () => {
  assert.match(webview, /function attentionSummaryHtml\(/);
  assert.match(webview, /count > 1 \? `Needs attention \(\$\{count\}\)` : 'Needs attention'/);
  assert.match(webview, /Focus next project that needs attention, \$\{count\} projects/);
  assert.match(webview, /id="attention-focus-status"/);
});

test('cycles through visible attention rows in list order and wraps', () => {
  const projects = [
    {
      id: 'alpha',
      name: 'Alpha',
      status: 'port-in-use',
      folder: '/alpha',
      services: []
    },
    {
      id: 'bravo',
      name: 'Bravo',
      status: 'stopped',
      folder: '/bravo',
      services: []
    },
    {
      id: 'charlie',
      name: 'Charlie',
      reviewRequired: true,
      status: 'stopped',
      folder: '/charlie',
      services: []
    }
  ];
  const harness = renderAttentionNavigationHarness(projects);

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[0].focusCount, 1);
  assert.equal(harness.attentionFocusStatus.textContent, 'Focused Alpha.');
  assert.equal(harness.savedStates.at(-1)?.lastAttentionFocusId, 'alpha');

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[2].focusCount, 1);
  assert.equal(harness.attentionFocusStatus.textContent, 'Focused Charlie.');
  assert.equal(harness.savedStates.at(-1)?.lastAttentionFocusId, 'charlie');

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[0].focusCount, 2);
  assert.equal(harness.attentionFocusStatus.textContent, 'Focused Alpha.');
});

test('skips filter-hidden attention rows', () => {
  const projects = [
    {
      id: 'alpha',
      name: 'Alpha',
      status: 'port-in-use',
      folder: '/alpha',
      services: []
    },
    {
      id: 'bravo',
      name: 'Bravo',
      reviewRequired: true,
      status: 'stopped',
      folder: '/bravo',
      services: []
    }
  ];
  const harness = renderAttentionNavigationHarness(projects, {
    hiddenProjectIds: ['alpha']
  });

  harness.evaluate(`
    document.querySelectorAll('.project-row').forEach((row) => {
      if (row.dataset.projectId === 'alpha') {
        row.hidden = true;
      }
    });
  `);

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[1].focusCount, 1);
  assert.equal(harness.savedStates.at(-1)?.lastAttentionFocusId, 'bravo');

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[1].focusCount, 2);
});

test('resets persisted focus when the attention set changes', () => {
  const projects = [
    {
      id: 'alpha',
      name: 'Alpha',
      status: 'port-in-use',
      folder: '/alpha',
      services: []
    },
    {
      id: 'bravo',
      name: 'Bravo',
      reviewRequired: true,
      status: 'stopped',
      folder: '/bravo',
      services: []
    }
  ];
  const harness = renderAttentionNavigationHarness(projects, {
    persistedWebviewState: {
      attentionFocusSignature: 'alpha\nbravo',
      lastAttentionFocusId: 'bravo'
    }
  });

  harness.evaluate(`
    state.projects = [{
      id: 'alpha',
      name: 'Alpha',
      status: 'port-in-use',
      folder: '/alpha',
      services: []
    }, {
      id: 'charlie',
      name: 'Charlie',
      reviewRequired: true,
      status: 'stopped',
      folder: '/charlie',
      services: []
    }];
    syncAttentionFocusState(state.projects);
  `);

  assert.equal(harness.evaluate('lastAttentionFocusId'), '');
  assert.equal(harness.evaluate('attentionFocusSignature'), 'alpha\ncharlie');
});

test('persists last-focused id in webview state', () => {
  assert.match(webview, /lastAttentionFocusId/);
  assert.match(webview, /attentionFocusSignature/);
  assert.match(webview, /function syncAttentionFocusState\(/);
  assert.match(webview, /function focusNextAttentionProject\(/);
  assert.match(webview, /'focus-attention': \(\) => focusNextAttentionProject\(\)/);
});
