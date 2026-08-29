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
    requestAnimationFrame(callback) {
      if (typeof callback === 'function') {
        callback();
      }
      return 1;
    },
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
    getSearchStatus() {
      return elements.get('project-search-status');
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

function setHiddenProjectRows(harness, hiddenProjectIds) {
  harness.evaluate(`
    document.querySelectorAll('.project-row').forEach((row) => {
      row.hidden = ${JSON.stringify(hiddenProjectIds)}.includes(row.dataset.projectId);
    });
  `);
}

test('keeps total attention count when filters hide troubled rows', () => {
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
  setHiddenProjectRows(harness, ['alpha']);

  const html = harness.evaluate('attentionSummaryHtml(state.projects)');
  assert.match(html, />Needs attention \(2\)</);
  assert.doesNotMatch(html, />Needs attention \(1\)</);
});

test('shows Clear filters when attention rows are hidden by filters', () => {
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
  setHiddenProjectRows(harness, ['alpha']);

  const html = harness.evaluate('attentionSummaryHtml(state.projects)');
  assert.match(html, /data-action="clear-filters-for-attention"/);
  assert.match(html, />Clear filters</);
  assert.match(html, /class="summary-attention-group"/);
});

test('aria-label reports visible and hidden attention counts when filters hide some rows', () => {
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
    },
    {
      id: 'charlie',
      name: 'Charlie',
      status: 'not-ready',
      folder: '/charlie',
      services: []
    }
  ];
  const harness = renderAttentionNavigationHarness(projects, {
    hiddenProjectIds: ['alpha', 'charlie']
  });
  setHiddenProjectRows(harness, ['alpha', 'charlie']);

  const html = harness.evaluate('attentionSummaryHtml(state.projects)');
  assert.match(html, /aria-label="Focus next project that needs attention, 1 of 3 visible, 2 hidden by filters"/);
});

test('does not show Clear filters when all attention rows are visible', () => {
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
  const harness = renderAttentionNavigationHarness(projects);

  const html = harness.evaluate('attentionSummaryHtml(state.projects)');
  assert.doesNotMatch(html, /clear-filters-for-attention/);
  assert.doesNotMatch(html, /summary-attention-group/);
});

test('announces hidden attention rows when cycling finds none visible', () => {
  const projects = [
    {
      id: 'alpha',
      name: 'Alpha',
      status: 'port-in-use',
      folder: '/alpha',
      services: []
    }
  ];
  const harness = renderAttentionNavigationHarness(projects, {
    hiddenProjectIds: ['alpha']
  });
  setHiddenProjectRows(harness, ['alpha']);

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(
    harness.getSearchStatus().textContent,
    'Some projects that need attention are hidden by your filters.'
  );
  assert.equal(harness.runButtons[0].focusCount, 0);
});

test('clear-filters-for-attention resets filters and focuses the first attention row', () => {
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
    }
  ];
  const harness = renderAttentionNavigationHarness(projects, {
    hiddenProjectIds: ['alpha']
  });
  setHiddenProjectRows(harness, ['alpha']);

  harness.evaluate(`
    searchQuery = 'bravo';
    selectedTagFilter = 'work';
    selectedGroupFilter = 'group-1';
    handleClearFiltersForAttention();
  `);

  assert.equal(harness.evaluate('searchQuery'), '');
  assert.equal(harness.evaluate('selectedTagFilter'), '');
  assert.equal(harness.evaluate('selectedGroupFilter'), '');
  assert.equal(harness.runButtons[0].focusCount, 1);
  assert.equal(harness.attentionFocusStatus.textContent, 'Focused Alpha.');
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

test('projectNeedsAttention includes stopped relink rows and not-ready rows', () => {
  const harness = renderAttentionNavigationHarness([]);
  const needsAttention = (project) => harness.evaluate(`projectNeedsAttention(${JSON.stringify(project)})`);

  assert.equal(needsAttention({
    id: 'moved',
    name: 'Moved app',
    status: 'stopped',
    folderAccessible: false
  }), true);
  assert.equal(needsAttention({
    id: 'slow',
    name: 'Slow app',
    status: 'not-ready',
    folder: '/slow',
    services: []
  }), true);
  assert.equal(needsAttention({
    id: 'conflict',
    name: 'Conflict app',
    status: 'port-in-use',
    folder: '/conflict',
    services: []
  }), true);
});

test('projectNeedsAttention includes running-elsewhere and ownership-lost rows that need Add stop command', () => {
  const harness = renderAttentionNavigationHarness([]);
  const needsAttention = (project) => harness.evaluate(`projectNeedsAttention(${JSON.stringify(project)})`);

  assert.equal(needsAttention({
    id: 'detected',
    name: 'Detected app',
    status: 'active',
    stopCommand: '',
    folder: '/detected',
    services: []
  }), true);
  assert.equal(needsAttention({
    id: 'ownership-lost',
    name: 'Lost app',
    status: 'ownership-lost',
    stopCommand: '',
    folder: '/lost',
    services: []
  }), true);
});

test('projectNeedsAttention excludes detected rows that already have a stop command', () => {
  const harness = renderAttentionNavigationHarness([]);
  const needsAttention = (project) => harness.evaluate(`projectNeedsAttention(${JSON.stringify(project)})`);

  assert.equal(needsAttention({
    id: 'detected-stop',
    name: 'Detected app',
    status: 'active',
    stopCommand: 'docker compose down',
    folder: '/detected',
    services: []
  }), false);
  assert.equal(needsAttention({
    id: 'ownership-stop',
    name: 'Lost app',
    status: 'ownership-lost',
    stopCommand: 'docker compose down',
    folder: '/lost',
    services: []
  }), false);
});

test('projectNeedsAttention does not double-count review, stop failure, or httpUnresponsive rows', () => {
  const harness = renderAttentionNavigationHarness([]);
  const needsAttention = (project) => harness.evaluate(`projectNeedsAttention(${JSON.stringify(project)})`);
  const attentionCount = (projects) => harness.evaluate(`(${JSON.stringify(projects)}).filter((project) => projectNeedsAttention(project)).length`);

  assert.equal(needsAttention({
    id: 'review',
    name: 'Review app',
    status: 'active',
    stopCommand: '',
    reviewRequired: true,
    folder: '/review',
    services: []
  }), true);
  assert.equal(needsAttention({
    id: 'stop-failure',
    name: 'Stop failed app',
    status: 'active',
    stopCommand: '',
    stopFailure: 'Port :3000 is still up',
    folder: '/stop-failure',
    services: []
  }), true);
  assert.equal(needsAttention({
    id: 'unresponsive',
    name: 'Unresponsive app',
    status: 'active',
    stopCommand: '',
    httpUnresponsive: true,
    folder: '/unresponsive',
    services: []
  }), true);
  assert.equal(attentionCount([
    {
      id: 'review',
      name: 'Review app',
      status: 'active',
      stopCommand: '',
      reviewRequired: true,
      folder: '/review',
      services: []
    },
    {
      id: 'stop-failure',
      name: 'Stop failed app',
      status: 'active',
      stopCommand: '',
      stopFailure: 'Port :3000 is still up',
      folder: '/stop-failure',
      services: []
    },
    {
      id: 'unresponsive',
      name: 'Unresponsive app',
      status: 'active',
      stopCommand: '',
      httpUnresponsive: true,
      folder: '/unresponsive',
      services: []
    }
  ]), 3);
});

test('running-elsewhere attention rows drop out after a stop command is saved', () => {
  const harness = renderAttentionNavigationHarness([]);
  const needsAttention = (project) => harness.evaluate(`projectNeedsAttention(${JSON.stringify(project)})`);

  const detected = {
    id: 'detected',
    name: 'Detected app',
    status: 'active',
    stopCommand: '',
    folder: '/detected',
    services: []
  };
  assert.equal(needsAttention(detected), true);
  assert.equal(needsAttention({ ...detected, stopCommand: 'docker compose down' }), false);
});

test('cycles through running-elsewhere attention rows and focuses Add stop command primary', () => {
  const projects = [
    {
      id: 'detected',
      name: 'Detected app',
      status: 'active',
      stopCommand: '',
      folder: '/detected',
      services: []
    },
    {
      id: 'ownership-lost',
      name: 'Lost app',
      status: 'ownership-lost',
      stopCommand: '',
      folder: '/lost',
      services: []
    }
  ];
  const harness = renderAttentionNavigationHarness(projects);

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[0].focusCount, 1);
  assert.equal(harness.attentionFocusStatus.textContent, 'Focused Detected app.');

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[1].focusCount, 1);
  assert.equal(harness.attentionFocusStatus.textContent, 'Focused Lost app.');

  harness.evaluate('focusNextAttentionProject()');
  assert.equal(harness.runButtons[0].focusCount, 2);
});

test('projectNeedsAttention excludes starting-only and live missing-folder rows', () => {
  const harness = renderAttentionNavigationHarness([]);
  const needsAttention = (project) => harness.evaluate(`projectNeedsAttention(${JSON.stringify(project)})`);

  assert.equal(needsAttention({
    id: 'starting',
    name: 'Starting app',
    status: 'starting',
    folder: '/starting',
    services: []
  }), false);
  assert.equal(needsAttention({
    id: 'running-missing',
    name: 'Running missing',
    status: 'running',
    folderAccessible: false
  }), false);
  assert.equal(needsAttention({
    id: 'compose-missing',
    name: 'Compose app',
    status: 'stopped',
    folderAccessible: false,
    composePath: '/tmp/compose.yaml'
  }), false);
  assert.equal(needsAttention({
    id: 'review-missing',
    name: 'Review app',
    status: 'stopped',
    folderAccessible: false,
    reviewRequired: true
  }), true);
});
