const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webviewSource = fs.readFileSync(
  path.join(__dirname, '..', 'media', 'main.js'),
  'utf8'
);

function renderNonEmptyProjectList(projects = [{
  activeLaunchProfileId: 'default',
  activeLaunchProfileName: 'Default',
  detailsExpanded: false,
  folder: 'C:\\Projects\\Example',
  id: 'example',
  launchProfiles: [],
  name: 'Example',
  openPorts: [],
  pinned: false,
  previewExpanded: false,
  reviewRequired: false,
  services: [],
  status: 'stopped',
  tags: []
}], { stateOverrides = {}, persistedWebviewState = {}, turkishLocale = false } = {}) {
  const listeners = [];
  const messageListeners = [];
  const scheduledFrames = [];
  const savedStates = [];
  const postedMessages = [];
  const elements = new Map();
  const previewListeners = new Map();
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 0;
  const inertElement = () => ({
    innerHTML: '',
    textContent: '',
    addEventListener(type) {
      listeners.push(type);
    },
    classList: { add() {}, remove() {}, contains() { return false; } },
    dataset: {},
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
    scrollIntoView() {},
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    remove() {},
    removeAttribute() {},
    setAttribute() {},
    style: { removeProperty() {}, setProperty() {} }
  });
  const app = inertElement();
  app.innerHTML = '';
  elements.set('app', app);
  elements.set('project-search', inertElement());
  elements.set('project-count', inertElement());
  elements.set('summary-status', inertElement());
  elements.set('project-search-status', inertElement());
  elements.set('project-lifecycle-status', inertElement());
  const searchEmpty = inertElement();
  searchEmpty.hidden = true;
  const projectRows = [];
  const syncProjectRows = (nextProjects) => {
    projectRows.length = 0;
    for (const project of nextProjects || []) {
      const row = inertElement();
      row.dataset = { projectId: String(project.id) };
      row.hidden = false;
      projectRows.push(row);
    }
  };
  syncProjectRows(projects);
  const previewProject = (projects || []).find((project) => project.previewExpanded && project.detailsExpanded);
  let visibleProjects = projects || [];
  const previewRow = inertElement();
  previewRow.dataset = { projectId: String(previewProject?.id || '') };
  const previewLoading = inertElement();
  previewLoading.hidden = true;
  const previewFallback = inertElement();
  previewFallback.hidden = true;
  const previewWrapper = inertElement();
  let previewLoaded = false;
  previewWrapper.classList = {
    add(name) { if (name === 'loaded') previewLoaded = true; },
    remove(name) { if (name === 'loaded') previewLoaded = false; },
    contains(name) { return name === 'loaded' && previewLoaded; }
  };
  previewWrapper.querySelector = (selector) => (
    selector === '[data-preview-loading]' ? previewLoading
      : selector === '[data-preview-fallback]' ? previewFallback
        : undefined
  );
  const previewFrame = inertElement();
  previewFrame.isConnected = true;
  previewFrame.dataset = {
    src: String(previewProject?.previewUrl || ''),
    previewIncarnation: String(previewProject?.projectIncarnation || '')
  };
  previewFrame.closest = (selector) => (
    selector === '.preview-frame-wrap' ? previewWrapper
      : selector === '.project-row' ? previewRow
        : undefined
  );
  previewFrame.addEventListener = (type, handler, options) => {
    const listenersForType = previewListeners.get(type) || [];
    listenersForType.push({ handler, once: options?.once === true });
    previewListeners.set(type, listenersForType);
  };
  previewFrame.removeEventListener = (type, handler) => {
    previewListeners.set(
      type,
      (previewListeners.get(type) || []).filter((listener) => listener.handler !== handler)
    );
  };
  const previewVisible = () => Boolean(
    visibleProjects.some((project) => project.previewExpanded && project.detailsExpanded)
  );
  const outputSlot = inertElement();
  outputSlot.dataset = {
    projectId: String(projects?.[0]?.id || 'example'),
    projectName: String(projects?.[0]?.name || 'Example')
  };
  let outputInteractionActive = false;
  outputSlot.contains = () => outputInteractionActive;
  outputSlot.innerHTML = 'initial output';
  let outputSlotVisible = true;

  const document = {
    activeElement: undefined,
    addEventListener() {},
    getElementById(id) {
      return elements.get(id);
    },
    querySelector(selector) {
      if (outputSlotVisible && selector.startsWith('[data-output-peek-slot]')) {
        const projectId = selector.match(/data-project-id="([^"]*)"/)?.[1];
        if (!projectId || projectId === outputSlot.dataset.projectId) {
          return outputSlot;
        }
      }
      if (selector.includes('[data-preview-frame]')) {
        return previewVisible() ? previewFrame : undefined;
      }
      if (selector === '[data-search-empty]') {
        return searchEmpty;
      }
      const projectId = selector.match(/data-project-id="([^"]*)"/)?.[1]
        || selector.match(/data-id="([^"]*)"/)?.[1];
      if (selector.includes('.project-row')) {
        return projectRows.find((row) => row.dataset.projectId === projectId);
      }
      if (selector.includes('.run-button')) {
        return projectRows.find((row) => row.dataset.projectId === projectId);
      }
      return undefined;
    },
    querySelectorAll(selector) {
      if (selector?.includes('[data-preview-frame]')) {
        return previewVisible() ? [previewFrame] : [];
      }
      if (selector === '.project-row') {
        return projectRows;
      }
      return [];
    }
  };
  const window = {
    RunlistMessageRouter: {
      createWebviewMessageRouter({ handlers, messageToken }) {
        return (event) => {
          if (event?.data?.messageToken !== messageToken) {
            return false;
          }
          const handler = handlers?.[event.data.type];
          if (typeof handler !== 'function') {
            return false;
          }
          handler(event.data);
          return true;
        };
      }
    },
    RunlistProjectActions: require('../media/project-actions'),
    RunlistProjectStatus: require('../media/project-status-display'),
    previewFrame,
    addEventListener(type, handler) {
      if (type === 'message') {
        messageListeners.push(handler);
      }
    },
    getSelection() {
      return undefined;
    },
    runlistState: {
      focusTarget: undefined,
      mode: 'list',
      projects,
      runGroups: [],
      runningAppIds: [],
      searchQuery: '',
      stopAllCount: 0,
      tagFilter: '',
      ...stateOverrides
    }
  };
  const context = {
    CSS: { escape: String },
    Map,
    Set,
    URL,
    acquireVsCodeApi() {
      return {
        getState() { return persistedWebviewState; },
        postMessage(message) {
          postedMessages.push(message);
        },
        setState(nextState) {
          savedStates.push(JSON.parse(JSON.stringify(nextState)));
        }
      };
    },
    cancelAnimationFrame() {},
    clearInterval() {},
    clearTimeout(id) {
      const timeout = timeoutCallbacks.get(id);
      if (timeout) {
        timeout.cleared = true;
      }
    },
    document,
    previewFrame,
    requestAnimationFrame(callback) {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    },
    setInterval() { return 1; },
    setTimeout(callback) {
      nextTimeoutId += 1;
      timeoutCallbacks.set(nextTimeoutId, { callback, cleared: false });
      return nextTimeoutId;
    },
    window
  };

  if (turkishLocale) {
    vm.runInNewContext(`
      String.prototype.toLocaleLowerCase = function toTurkishLocaleLowerCase() {
        return this.toString().replaceAll('I', 'ı').replaceAll('İ', 'i').toLowerCase();
      };
    `, context);
  }

  vm.runInNewContext(webviewSource, context, { filename: 'media/main.js' });
  return {
    app,
    document,
    lifecycleStatus: elements.get('project-lifecycle-status'),
    projectCount: elements.get('project-count'),
    listeners,
    rerender() {
      visibleProjects = context.window.runlistState.projects || [];
      syncProjectRows(visibleProjects);
      const project = visibleProjects.find((item) => item.previewExpanded && item.detailsExpanded);
      previewRow.dataset.projectId = String(project?.id || '');
      previewFrame.dataset.src = String(project?.previewUrl || '');
      previewFrame.dataset.previewIncarnation = project
        ? String(project.projectIncarnation
          || vm.runInNewContext(`projectIncarnations.get(${JSON.stringify(String(project.id))}) || ''`, context))
        : '';
      previewFrame.isConnected = Boolean(project?.previewExpanded && project?.detailsExpanded);
      vm.runInNewContext('renderList()', context);
    },
    deliver(message) {
      for (const listener of messageListeners) {
        listener({ data: message });
      }
    },
    evaluate(source) {
      return vm.runInNewContext(source, context);
    },
    outputSlot,
    previewFrame,
    previewLoading,
    previewFallback,
    previewHandler(type) {
      return (previewListeners.get(type) || [])[0]?.handler;
    },
    timeoutCallback(id) {
      return timeoutCallbacks.get(id)?.callback;
    },
    triggerPreview(type) {
      const listenersForType = previewListeners.get(type) || [];
      previewListeners.set(type, listenersForType.filter((listener) => !listener.once));
      for (const listener of listenersForType) {
        listener.handler({ type });
      }
    },
    postedMessages,
    projectRows,
    scheduledFrames,
    savedStates,
    searchEmpty,
    searchInput: elements.get('project-search'),
    searchStatus: elements.get('project-search-status'),
    setOutputSlot(project) {
      outputSlotVisible = Boolean(project);
      if (project) {
        outputSlot.dataset.projectId = String(project.id);
        outputSlot.dataset.projectName = String(project.name);
      }
    },
    setOutputInteractionActive(active) {
      outputInteractionActive = Boolean(active);
    },
    state: window.runlistState
  };
}

test('a non-empty project list finishes webview interaction setup', () => {
  const result = renderNonEmptyProjectList();

  assert.match(result.app.innerHTML, /data-project-id="example"/);
  assert.ok(result.listeners.includes('input'), 'search input listener was installed');
  assert.ok(result.scheduledFrames.length >= 3, 'render follow-up work was scheduled');
});

test('renders an escaped accessible diagnosis-closed notice without stale diagnosis controls', () => {
  const result = renderNonEmptyProjectList(undefined, {
    stateOverrides: {
      routeNotice: 'Project <gone> & its diagnosis were closed.'
    }
  });

  assert.match(
    result.app.innerHTML,
    /id="route-notice" class="diagnosis-notice" role="status" aria-live="polite" aria-atomic="true"/
  );
  assert.match(result.app.innerHTML, /Project &lt;gone&gt; &amp; its diagnosis were closed\./);
  assert.doesNotMatch(result.app.innerHTML, /data-action="copy-diagnosis-request"|data-action="refresh-repair"/);
});

test('prunes deleted project and service state while preserving state for present projects', () => {
  const gone = {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    defaultDetailTab: 'output',
    detailTabs: ['overview', 'services', 'output'],
    detailsExpanded: true,
    folder: 'C:\\Projects\\Gone',
    id: 'gone',
    launchProfiles: [],
    name: 'Gone',
    openPorts: [],
    phoneHandoff: { qrSvg: '<svg></svg>', url: 'http://localhost:3000' },
    pinned: false,
    previewExpanded: true,
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    startupHistory: [{ completedAt: 1000, durationMs: 100, failureSummary: 'gone failure', outcome: 'failed' }],
    status: 'stopped',
    tags: ['keep']
  };
  const kept = {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    defaultDetailTab: 'preview',
    detailTabs: ['overview', 'services', 'output', 'preview'],
    detailsExpanded: true,
    folder: 'C:\\Projects\\Kept',
    id: 'kept',
    launchProfiles: [],
    name: 'Kept',
    openPorts: [],
    phoneHandoff: { qrSvg: '<svg></svg>', url: 'http://localhost:4000' },
    pinned: false,
    previewExpanded: true,
    reviewRequired: false,
    services: [{ name: 'Web', port: 4000 }],
    startupHistory: [{ completedAt: 2000, durationMs: 200, failureSummary: 'kept failure', outcome: 'failed' }],
    status: 'stopped',
    tags: ['keep']
  };
  const result = renderNonEmptyProjectList([gone, kept], {
    stateOverrides: { tags: ['keep'] },
    persistedWebviewState: {
      detailTabs: { gone: 'output', kept: 'output' },
      expandedServices: { gone: '3000', kept: '4000', stale: '9999' },
      phoneHandoffs: { gone: true, kept: true },
      startupFailures: { gone: '1000-100-0', kept: '2000-200-0' },
      filterRevision: 1,
      searchQuery: 'keep',
      searchSelectionStart: 1,
      searchSelectionEnd: 3,
      searchFocused: true,
      tagFilter: 'keep',
      tagsExpanded: true
    }
  });

  result.state.projects = [kept];
  result.rerender();
  const afterRemoval = result.savedStates.at(-1);
  assert.deepEqual(afterRemoval.detailTabs, { kept: 'output' });
  assert.deepEqual(afterRemoval.expandedServices, { kept: '4000' });
  assert.deepEqual(afterRemoval.phoneHandoffs, { kept: true });
  assert.deepEqual(afterRemoval.startupFailures, { kept: '2000-200-0' });
  assert.equal(afterRemoval.searchQuery, 'keep');
  assert.equal(afterRemoval.tagFilter, 'keep');
  assert.equal(afterRemoval.searchSelectionStart, 1);
  assert.equal(afterRemoval.searchSelectionEnd, 3);
  assert.equal(afterRemoval.tagsExpanded, true);

  const recreated = {
    ...gone,
    defaultDetailTab: 'preview',
    detailTabs: ['overview', 'services', 'output', 'preview'],
    name: 'Recreated'
  };
  result.state.projects = [recreated, kept];
  result.rerender();
  result.evaluate('saveWebviewState()');
  const afterRecreation = result.savedStates.at(-1);
  assert.equal(afterRecreation.detailTabs.gone, 'preview');
  assert.equal(afterRecreation.expandedServices.gone, undefined);
  assert.equal(afterRecreation.phoneHandoffs.gone, undefined);
  assert.equal(afterRecreation.startupFailures.gone, undefined);
  assert.match(result.app.innerHTML, /data-action="toggle-service-detail" data-id="gone" data-port="3000" aria-expanded="false"/);
  assert.equal(afterRecreation.detailTabs.kept, 'output');
  assert.equal(afterRecreation.expandedServices.kept, '4000');
  assert.equal(afterRecreation.phoneHandoffs.kept, true);
  assert.equal(afterRecreation.startupFailures.kept, '2000-200-0');
});

test('ignores output peek responses from a removed project incarnation', () => {
  const project = {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: true,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [],
    outputPeek: [],
    pinned: false,
    previewExpanded: true,
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    status: 'running',
    tags: []
  };
  const result = renderNonEmptyProjectList([project], {
    stateOverrides: { messageToken: 'webview-token' }
  });
  const incarnationA = result.evaluate("typeof projectIncarnations === 'undefined' ? undefined : projectIncarnations.get('example')");
  assert.equal(typeof incarnationA, 'string');
  assert.deepEqual(JSON.parse(JSON.stringify(result.postedMessages.find((message) => message.type === 'showOutput'))), {
    type: 'showOutput',
    id: 'example',
    projectIncarnation: incarnationA
  });

  result.state.projects = [];
  result.setOutputSlot(undefined);
  result.rerender();
  assert.equal(result.evaluate("projectIncarnations.has('example')"), false);
  const recreated = { ...project, name: 'Recreated' };
  result.state.projects = [recreated];
  result.setOutputSlot(recreated);
  result.outputSlot.innerHTML = 'current incarnation';
  result.rerender();
  const incarnationB = result.evaluate("typeof projectIncarnations === 'undefined' ? undefined : projectIncarnations.get('example')");
  assert.notEqual(incarnationB, incarnationA);
  assert.deepEqual(JSON.parse(JSON.stringify(result.postedMessages.at(-1))), {
    type: 'showOutput',
    id: 'example',
    projectIncarnation: incarnationB
  });

  result.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    entries: [{ kind: 'raw', message: 'missing token' }]
  });
  assert.equal(result.outputSlot.innerHTML, 'current incarnation');

  result.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnationA,
    entries: [{ kind: 'raw', message: 'stale output' }]
  });
  assert.equal(result.outputSlot.innerHTML, 'current incarnation');
  assert.equal(result.evaluate("typeof pendingOutputPeeks === 'undefined' ? 0 : pendingOutputPeeks.size"), 0);

  result.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnationB,
    entries: [{ kind: 'raw', message: 'current output' }]
  });
  assert.match(result.outputSlot.innerHTML, /current output/);
});

test('accepts a current output peek after an ordinary status rerender', () => {
  const project = {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: true,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [],
    outputPeek: [],
    pinned: false,
    previewExpanded: true,
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    status: 'running',
    tags: []
  };
  const result = renderNonEmptyProjectList([project], {
    stateOverrides: { messageToken: 'webview-token' }
  });
  const incarnation = result.evaluate("typeof projectIncarnations === 'undefined' ? undefined : projectIncarnations.get('example')");
  assert.deepEqual(JSON.parse(JSON.stringify(result.postedMessages.find((message) => message.type === 'showOutput'))), {
    type: 'showOutput',
    id: 'example',
    projectIncarnation: incarnation
  });
  result.state.projects[0].status = 'not-ready';
  result.rerender();
  assert.deepEqual(JSON.parse(JSON.stringify(result.postedMessages.at(-1))), {
    type: 'showOutput',
    id: 'example',
    projectIncarnation: incarnation
  });
  result.outputSlot.innerHTML = 'before current response';
  result.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnation,
    entries: [{ kind: 'raw', message: 'still current' }]
  });
  assert.match(result.outputSlot.innerHTML, /still current/);
});

test('rejects an old output peek after a fresh webview document recreates the project', () => {
  const project = {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: true,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [],
    outputPeek: [],
    pinned: false,
    previewExpanded: true,
    projectIncarnation: 'host:1',
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    status: 'running',
    tags: []
  };
  const firstDocument = renderNonEmptyProjectList([project], {
    stateOverrides: { messageToken: 'webview-token' }
  });
  const incarnationA = firstDocument.evaluate("projectIncarnations.get('example')");
  firstDocument.state.projects = [];
  firstDocument.setOutputSlot(undefined);
  firstDocument.rerender();

  const recreated = { ...project, name: 'Recreated', projectIncarnation: 'host:2' };
  const freshDocument = renderNonEmptyProjectList([recreated], {
    stateOverrides: { messageToken: 'webview-token' }
  });
  const incarnationB = freshDocument.evaluate("projectIncarnations.get('example')");
  assert.notEqual(incarnationB, incarnationA);
  freshDocument.outputSlot.innerHTML = 'current incarnation';

  freshDocument.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnationA,
    entries: [{ kind: 'raw', message: 'stale output' }]
  });
  assert.equal(freshDocument.outputSlot.innerHTML, 'current incarnation');
  assert.equal(freshDocument.evaluate('pendingOutputPeeks.size'), 0);

  freshDocument.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnationB,
    entries: [{ kind: 'raw', message: 'current output' }]
  });
  assert.match(freshDocument.outputSlot.innerHTML, /current output/);
});

test('drops queued output from an old incarnation before flushing a recreated project', () => {
  const project = {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: true,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [],
    outputPeek: [],
    pinned: false,
    previewExpanded: true,
    projectIncarnation: 'host:1',
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    status: 'running',
    tags: []
  };
  const result = renderNonEmptyProjectList([project], {
    stateOverrides: { messageToken: 'webview-token' }
  });
  const incarnationA = result.evaluate("projectIncarnations.get('example')");
  result.setOutputInteractionActive(true);
  result.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnationA,
    entries: [{ kind: 'raw', message: 'stale output' }]
  });
  assert.equal(result.evaluate('pendingOutputPeeks.size'), 1);
  assert.equal(result.evaluate("pendingOutputPeeks.get('example').projectIncarnation"), incarnationA);

  result.state.projects = [];
  result.setOutputSlot(undefined);
  result.evaluate("projectIncarnations.delete('example')");
  const recreated = { ...project, name: 'Recreated', projectIncarnation: 'host:2' };
  result.state.projects = [recreated];
  result.setOutputSlot(recreated);
  result.rerender();
  const incarnationB = result.evaluate("projectIncarnations.get('example')");
  assert.notEqual(incarnationB, incarnationA);

  result.setOutputInteractionActive(false);
  result.outputSlot.innerHTML = 'current incarnation';
  result.evaluate('flushPendingOutputPeeks()');
  assert.equal(result.outputSlot.innerHTML, 'current incarnation');
  assert.equal(result.evaluate('pendingOutputPeeks.size'), 0);

  result.deliver({
    type: 'projectOutputPeek',
    messageToken: 'webview-token',
    id: 'example',
    projectIncarnation: incarnationB,
    entries: [{ kind: 'raw', message: 'current output' }]
  });
  assert.match(result.outputSlot.innerHTML, /current output/);
});

test('keeps conflict-owner HTML escaped while announcing its raw name', () => {
  const ownerName = 'A&B <team>';
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [3000],
    pinned: false,
    portConflict: { ownerName, port: 3000 },
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    status: 'stopped',
    tags: []
  }]);

  result.state.projects[0].status = 'port-in-use';
  result.rerender();

  assert.match(result.app.innerHTML, /1 service blocked by A&amp;B &lt;team&gt;/);
  assert.equal(result.lifecycleStatus.textContent, 'Example: 1 service blocked by A&B <team>');
  assert.doesNotMatch(result.lifecycleStatus.textContent, /&amp;|&lt;|&gt;/);
});

test('shows blocking service name and port on not-ready and not-responding list rows', () => {
  const notReady = renderNonEmptyProjectList([
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Example',
      id: 'example',
      launchProfiles: [],
      name: 'Example',
      openPorts: [3000],
      pinned: false,
      reviewRequired: false,
      services: [
        { name: 'Web', port: 3000 },
        { name: 'API', port: 4000 }
      ],
      serviceReadiness: {
        ready: [{ name: 'Web', port: 3000 }],
        waiting: [{ name: 'API', port: 4000 }],
        notResponding: []
      },
      status: 'not-ready',
      tags: [],
      timeline: { launchedAt: Date.now() - 5000 }
    }
  ]);

  assert.match(notReady.app.innerHTML, /Taking longer — API :4000/);
  assert.doesNotMatch(notReady.app.innerHTML, /class="project-readiness-detail"/);

  const notResponding = renderNonEmptyProjectList([
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Example',
      id: 'example',
      launchProfiles: [],
      name: 'Example',
      openPorts: [3000, 4000],
      pinned: false,
      reviewRequired: false,
      services: [
        { name: 'Web', port: 3000 },
        { name: 'API', port: 4000 },
        { name: 'Worker', port: 5000 }
      ],
      serviceReadiness: {
        ready: [{ name: 'Web', port: 3000 }],
        waiting: [],
        notResponding: [{ name: 'API', port: 4000 }, { name: 'Worker', port: 5000 }]
      },
      status: 'not-responding',
      tags: [],
      timeline: { launchedAt: Date.now() - 5000 }
    }
  ]);

  assert.match(notResponding.app.innerHTML, /Web service not responding — API :4000 \+1 more/);
  assert.doesNotMatch(notResponding.app.innerHTML, /class="project-readiness-detail"/);
  assert.match(
    notResponding.app.innerHTML,
    /class="run-button output"[^>]*data-action="output"[^>]*aria-label="View output for Example"/
  );
  assert.match(
    notResponding.app.innerHTML,
    /data-action="stop" data-id="example" role="menuitem"[^>]*aria-label="Stop Example"/
  );
  assert.match(
    notResponding.app.innerHTML,
    /data-action="restart" data-id="example" role="menuitem"[^>]*aria-label="Restart Example"/
  );
  assert.doesNotMatch(notResponding.app.innerHTML, /class="run-button stop"[^>]*data-action="stop"/);
});

test('active httpUnresponsive row uses View output primary with Stop in More', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: 'C:\\Projects\\Detected',
    httpUnresponsive: true,
    id: 'detected',
    launchProfiles: [],
    name: 'Detected App',
    openPorts: [3000],
    pinned: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }],
    status: 'active',
    stopCommand: 'npm run stop',
    tags: []
  }]);

  assert.match(
    result.app.innerHTML,
    /class="run-button output"[^>]*data-action="output"[^>]*aria-label="View output for Detected App"/
  );
  assert.match(
    result.app.innerHTML,
    /data-action="stop" data-id="detected" role="menuitem"[^>]*aria-label="Stop Detected App"/
  );
  assert.doesNotMatch(result.app.innerHTML, /class="run-button stop"[^>]*data-action="stop"/);
});

test('not-ready row keeps Stop as the primary action', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [3000],
    pinned: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }],
    serviceReadiness: {
      ready: [],
      waiting: [{ name: 'web', port: 3000 }],
      notResponding: []
    },
    status: 'not-ready',
    tags: []
  }]);

  assert.match(
    result.app.innerHTML,
    /class="run-button stop"[^>]*data-action="stop"[^>]*aria-label="Stop Example"/
  );
  assert.doesNotMatch(result.app.innerHTML, /class="run-button output"[^>]*data-action="output"/);
});

test('announces contextual project and service status changes once without noisy repeats', () => {
  const result = renderNonEmptyProjectList([
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Example',
      id: 'example',
      launchProfiles: [],
      name: 'Example',
      openPorts: [],
      pinned: false,
      reviewRequired: false,
      services: [
        { name: 'Web', port: 3000 },
        { name: 'API', port: 4000 }
      ],
      serviceReadiness: {
        ready: [],
        waiting: [{ name: 'Web', port: 3000 }, { name: 'API', port: 4000 }],
        notResponding: []
      },
      status: 'not-ready',
      tags: []
    }
  ]);

  result.state.projects[0].serviceReadiness = {
    ready: [{ name: 'Web', port: 3000 }],
    waiting: [{ name: 'API', port: 4000 }],
    notResponding: []
  };
  result.rerender();

  assert.equal(
    result.lifecycleStatus.textContent,
    'Example: Taking longer… Ready: Web :3000. Still checking: API :4000'
  );

  const unchangedAnnouncement = result.lifecycleStatus.textContent;
  result.rerender();
  assert.equal(result.lifecycleStatus.textContent, unchangedAnnouncement);

  result.state.projects[0].status = 'running';
  result.state.projects[0].serviceReadiness = undefined;
  result.rerender();
  assert.equal(result.lifecycleStatus.textContent, 'Example: Running');
});

test('announces simultaneous service contexts with raw special-character names', () => {
  const result = renderNonEmptyProjectList([
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\One',
      id: 'one',
      launchProfiles: [],
      name: 'A&B <team>',
      openPorts: [],
      pinned: false,
      reviewRequired: false,
      services: [{ name: 'Web & <blue>', port: 3000 }],
      serviceReadiness: {
        ready: [],
        waiting: [{ name: 'Web & <blue>', port: 3000 }],
        notResponding: []
      },
      status: 'stopped',
      tags: []
    },
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Two',
      id: 'two',
      launchProfiles: [],
      name: 'Two',
      openPorts: [],
      pinned: false,
      reviewRequired: false,
      services: [{ name: 'Worker', port: 5000 }],
      serviceReadiness: {
        ready: [],
        waiting: [{ name: 'Worker', port: 5000 }],
        notResponding: []
      },
      status: 'stopped',
      tags: []
    }
  ]);

  result.state.projects[0].status = 'not-ready';
  result.state.projects[1].status = 'not-ready';
  result.rerender();

  assert.equal(
    result.lifecycleStatus.textContent,
    'A&B <team>: Taking longer… Still checking: Web & <blue> :3000. Two: Taking longer… Still checking: Worker :5000'
  );
  assert.doesNotMatch(result.lifecycleStatus.textContent, /&amp;|&lt;|&gt;/);
});

function previewFailureProject(overrides = {}) {
  return {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: true,
    folder: 'C:\\Projects\\Preview',
    id: 'preview',
    launchProfiles: [],
    name: 'Preview & <team>',
    openPorts: [3000],
    pinned: false,
    previewExpanded: true,
    previewUrl: 'http://localhost:3000',
    projectIncarnation: 'host:preview-1',
    reviewRequired: false,
    services: [{ name: 'Web', port: 3000 }],
    status: 'running',
    tags: [],
    ...overrides
  };
}

test('announces one contextual preview failure without leaking raw error data', () => {
  const result = renderNonEmptyProjectList([previewFailureProject()]);

  result.triggerPreview('error');

  assert.equal(
    result.lifecycleStatus.textContent,
    'Preview & <team>: Preview unavailable. Open it in a browser to view it.'
  );
  assert.equal(result.previewLoading.hidden, true);
  assert.equal(result.previewFallback.hidden, false);
  assert.doesNotMatch(result.lifecycleStatus.textContent, /<script>|error|localhost:3000/);

  const firstAnnouncement = result.lifecycleStatus.textContent;
  result.triggerPreview('error');
  assert.equal(result.lifecycleStatus.textContent, firstAnnouncement);
});

test('ignores preview failure events with a stale or missing project incarnation', () => {
  const stale = renderNonEmptyProjectList([previewFailureProject()]);
  stale.previewFrame.dataset.previewIncarnation = 'host:preview-2';
  stale.triggerPreview('error');
  assert.equal(stale.lifecycleStatus.textContent, '');

  const missing = renderNonEmptyProjectList([previewFailureProject()]);
  missing.previewFrame.dataset.previewIncarnation = '';
  missing.triggerPreview('error');
  assert.equal(missing.lifecycleStatus.textContent, '');
});

test('detached preview callbacks cannot announce or clear after collapse and same-incarnation rerender', () => {
  const result = renderNonEmptyProjectList([previewFailureProject()]);
  const oldError = result.previewHandler('error');
  const oldLoad = result.previewHandler('load');
  const oldTimeout = result.timeoutCallback(result.evaluate('activePreviewLoad.timer'));

  result.state.projects[0].detailsExpanded = false;
  result.state.projects[0].previewExpanded = false;
  result.rerender();
  assert.equal(result.previewFrame.isConnected, false);
  assert.equal(result.evaluate('activePreviewLoad'), undefined);

  result.lifecycleStatus.textContent = 'Current lifecycle status';
  const loadingBefore = result.previewLoading.hidden;
  const fallbackBefore = result.previewFallback.hidden;
  oldError();
  oldTimeout();
  oldLoad();
  assert.equal(result.lifecycleStatus.textContent, 'Current lifecycle status');
  assert.equal(result.previewLoading.hidden, loadingBefore);
  assert.equal(result.previewFallback.hidden, fallbackBefore);

  result.state.projects[0].detailsExpanded = true;
  result.state.projects[0].previewExpanded = true;
  delete result.previewFrame.dataset.loadedSource;
  result.rerender();
  assert.equal(result.previewFrame.isConnected, true);
  result.lifecycleStatus.textContent = '';

  oldError();
  oldTimeout();
  oldLoad();
  assert.equal(result.lifecycleStatus.textContent, '');

  result.triggerPreview('error');
  assert.equal(
    result.lifecycleStatus.textContent,
    'Preview & <team>: Preview unavailable. Open it in a browser to view it.'
  );

  result.evaluate("delete previewFrame.dataset.loadedSource; loadProjectPreview(previewFrame)");
  result.triggerPreview('load');
  assert.equal(result.lifecycleStatus.textContent, '');
});

test('clears a preview failure after success and announces a later retry once', () => {
  const result = renderNonEmptyProjectList([previewFailureProject()]);
  result.triggerPreview('error');
  assert.match(result.lifecycleStatus.textContent, /Preview unavailable/);

  result.evaluate("delete previewFrame.dataset.loadedSource; loadProjectPreview(previewFrame)");
  result.triggerPreview('load');
  assert.equal(result.lifecycleStatus.textContent, '');
  assert.equal(result.previewFallback.hidden, true);

  result.evaluate("delete previewFrame.dataset.loadedSource; loadProjectPreview(previewFrame)");
  result.triggerPreview('error');
  assert.equal(
    result.lifecycleStatus.textContent,
    'Preview & <team>: Preview unavailable. Open it in a browser to view it.'
  );
});

test('renders an open-in-browser action in the preview fallback when open is allowed', () => {
  const result = renderNonEmptyProjectList([previewFailureProject({
    defaultDetailTab: 'preview',
    detailTabs: ['overview', 'preview'],
    previewPort: 3000
  })]);
  assert.match(
    result.app.innerHTML,
    /data-preview-fallback[\s\S]*data-action="open" data-id="preview"[\s\S]*aria-label="Open Preview &amp; &lt;team&gt; in browser"[\s\S]*Open in browser/
  );

  const blocked = renderNonEmptyProjectList([previewFailureProject({
    defaultDetailTab: 'preview',
    detailTabs: ['overview', 'preview'],
    previewUrl: ''
  })]);
  assert.doesNotMatch(blocked.app.innerHTML, /data-preview-fallback[\s\S]*data-action="open"/);
});

test('does not announce an empty preview source', () => {
  const result = renderNonEmptyProjectList([previewFailureProject({
    previewExpanded: false,
    previewUrl: ''
  })]);
  result.triggerPreview('error');
  assert.equal(result.lifecycleStatus.textContent, '');
});

test('restores the latest search and tag filters after a host rerender', () => {
  const result = renderNonEmptyProjectList([
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Frontend',
      id: 'frontend',
      launchProfiles: [],
      name: 'Frontend app',
      openPorts: [],
      pinned: false,
      previewExpanded: false,
      reviewRequired: false,
      services: [],
      status: 'stopped',
      tags: ['frontend']
    },
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Docs',
      id: 'docs',
      launchProfiles: [],
      name: 'Docs',
      openPorts: [],
      pinned: false,
      previewExpanded: false,
      reviewRequired: false,
      services: [],
      status: 'stopped',
      tags: ['docs']
    }
  ], {
    stateOverrides: { tags: ['docs', 'frontend'] },
    persistedWebviewState: {
      filterRevision: 1,
      searchQuery: 'frontend',
      tagFilter: 'frontend'
    }
  });

  assert.match(result.app.innerHTML, /id="project-search"[^>]*value="frontend"/);
  assert.match(result.app.innerHTML, /class="active-tag-chip"[^>]*data-tag="frontend"/);
  assert.doesNotMatch(result.app.innerHTML, /value=""/);
});

test('keeps search focus and caret through a rerender and preserves empty state', () => {
  const result = renderNonEmptyProjectList();
  const searchInput = result.searchInput;
  let focusCount = 0;
  let restoredSelection;
  searchInput.id = 'project-search';
  searchInput.selectionStart = 2;
  searchInput.selectionEnd = 4;
  searchInput.focus = () => {
    focusCount += 1;
  };
  searchInput.setSelectionRange = (start, end) => {
    restoredSelection = [start, end];
  };
  result.document.activeElement = searchInput;

  result.rerender();

  assert.equal(focusCount, 1);
  assert.deepEqual(restoredSelection, [2, 4]);

  result.state.projects = [];
  result.rerender();
  assert.match(result.app.innerHTML, /No projects yet/);

  result.state.lifecycleWindowSupported = false;
  result.rerender();
  assert.match(result.app.innerHTML, /Remote SSH, Dev Containers/);
});

test('restores selection only for search focus in a fresh webview document', () => {
  const persistedWebviewState = {
    filterRevision: 4,
    searchQuery: 'frontend',
    tagFilter: 'frontend',
    searchSelectionStart: 2,
    searchSelectionEnd: 4,
    searchFocused: true
  };
  const first = renderNonEmptyProjectList(undefined, {
    stateOverrides: { tags: ['frontend'] },
    persistedWebviewState
  });
  const second = renderNonEmptyProjectList(undefined, {
    stateOverrides: { tags: ['frontend'] },
    persistedWebviewState
  });

  assert.notEqual(first.searchInput, second.searchInput);
  assert.equal(second.searchInput.focusCount, 1);
  assert.equal(second.searchInput.selectionStart, 2);
  assert.equal(second.searchInput.selectionEnd, 4);
});

test('does not steal search focus when the accepted filter state says it was elsewhere', () => {
  const result = renderNonEmptyProjectList(undefined, {
    stateOverrides: {
      filterRevision: 4,
      filterRevisionSeen: true,
      focusTarget: { type: 'field', id: 'project-search' },
      searchFocused: false,
      searchQuery: 'frontend',
      tags: ['frontend']
    }
  });

  assert.equal(result.searchInput.focusCount, 0);
});

test('matches Turkish-sensitive tags with locale-independent identity and filters the right subset', () => {
  const result = renderNonEmptyProjectList([
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\I-tag',
      id: 'i-tag',
      launchProfiles: [],
      name: 'I tag',
      openPorts: [],
      pinned: false,
      previewExpanded: false,
      reviewRequired: false,
      services: [],
      status: 'stopped',
      tags: ['I']
    },
    {
      activeLaunchProfileId: 'default',
      activeLaunchProfileName: 'Default',
      detailsExpanded: false,
      folder: 'C:\\Projects\\Other',
      id: 'other',
      launchProfiles: [],
      name: 'Other',
      openPorts: [],
      pinned: false,
      previewExpanded: false,
      reviewRequired: false,
      services: [],
      status: 'stopped',
      tags: ['Other']
    }
  ], {
    stateOverrides: { tags: ['I', 'Other'] },
    persistedWebviewState: {
      filterRevision: 1,
      searchQuery: '',
      tagFilter: 'i'
    },
    turkishLocale: true
  });

  assert.match(result.app.innerHTML, /class="active-tag-chip"[^>]*data-tag="I"/);
  assert.match(result.projectCount.innerHTML, /<strong>1<\/strong> of 2 projects/);
});

test('empty state offers Add this folder when a workspace folder is present', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      currentWorkspaceFolder: '/Users/example/app',
      currentWorkspaceFolderName: 'app',
      workspaceStartScripts: [
        { name: 'start', startCommand: 'npm start' },
        { name: 'dev', startCommand: 'npm run dev' }
      ]
    }
  });

  assert.match(result.app.innerHTML, /No projects yet/);
  assert.match(result.app.innerHTML, /Add this folder/);
  assert.match(result.app.innerHTML, /Add app open in this window\./);
  assert.match(result.app.innerHTML, /class="empty-folder"[^>]*>app</);
  assert.match(result.app.innerHTML, /class="empty-start-chips"/);
  assert.match(result.app.innerHTML, /data-action="start-workspace-script" data-script="dev"/);
  assert.match(result.app.innerHTML, />\s*Start\s*</);
  assert.match(result.app.innerHTML, />\s*Dev\s*</);
  assert.match(result.app.innerHTML, /aria-label="Save and start `npm start` for this folder"/);
  assert.match(result.app.innerHTML, /aria-label="Save and start `npm run dev` for this folder"/);
  assert.doesNotMatch(result.app.innerHTML, />Add project</);
  assert.doesNotMatch(result.app.innerHTML, /Load stack/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="use-draft-start-script"/);
});

test('empty state shows Load stack when a stack contract is pending', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      currentWorkspaceFolder: '/Users/example/app',
      currentWorkspaceFolderName: 'app',
      stackContractPending: true
    }
  });

  assert.match(result.app.innerHTML, /data-action="load-workspace-stack">Load stack</);
});

test('empty state hides Add this folder when no workspace folder is open', () => {
  const result = renderNonEmptyProjectList([]);

  assert.match(result.app.innerHTML, /Open a folder in this window first\./);
  assert.doesNotMatch(result.app.innerHTML, /Add this folder/);
  assert.doesNotMatch(result.app.innerHTML, />Add project</);
});

test('marks the current-window project without replacing its name', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    currentWorkspace: true,
    detailsExpanded: false,
    folder: 'C:\\Projects\\Example',
    id: 'example',
    launchProfiles: [],
    name: 'Example',
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [],
    status: 'stopped',
    tags: []
  }]);

  assert.doesNotMatch(result.app.innerHTML, /class="current-window-label"/);
  assert.match(result.app.innerHTML, /aria-label="Example, this window"/);
  assert.match(result.app.innerHTML, /role="menuitem" disabled>[\s\S]*This window/);
});

function projectFormDraft(overrides = {}) {
  return {
    name: '',
    folder: '/Users/example/app',
    startCommand: 'npm run dev',
    stopCommand: '',
    services: [],
    launchProfiles: [],
    selectedLaunchProfileId: 'default',
    ...overrides
  };
}

test('hides launch profiles on first add when only Default exists', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'add',
      draft: projectFormDraft(),
      formErrors: {}
    }
  });

  assert.match(result.app.innerHTML, /<h2>Add this folder<\/h2>/);
  assert.match(result.app.innerHTML, /aria-label="Close add this folder screen"/);
  assert.doesNotMatch(result.app.innerHTML, /class="launch-profile-editor"/);
  assert.match(result.app.innerHTML, /class="more-options"/);
  assert.doesNotMatch(result.app.innerHTML, /class="more-options" open/);
  assert.match(result.app.innerHTML, /id="folder"/);
  assert.match(result.app.innerHTML, /id="start-command"/);
  assert.ok(
    result.app.innerHTML.indexOf('id="folder"') < result.app.innerHTML.indexOf('class="more-options"')
  );
  assert.ok(
    result.app.innerHTML.indexOf('id="start-command"') < result.app.innerHTML.indexOf('class="more-options"')
  );
  assert.ok(
    result.app.innerHTML.indexOf('class="more-options"') < result.app.innerHTML.indexOf('id="project-name"')
  );
});

test('opens More options on edit so advanced fields stay visible', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'edit',
      reviewRequired: false,
      draft: projectFormDraft({ id: 'example', name: 'Example' }),
      formErrors: {}
    }
  });
  assert.match(result.app.innerHTML, /class="more-options" open/);
  assert.match(result.app.innerHTML, /id="project-name"/);
  assert.match(result.app.innerHTML, /class="launch-profile-editor"/);
});

test('shows launch profiles when editing or when alternatives already exist', () => {
  const editDefault = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'edit',
      reviewRequired: false,
      draft: projectFormDraft({ id: 'example', name: 'Example' }),
      formErrors: {}
    }
  });
  assert.match(editDefault.app.innerHTML, /class="launch-profile-editor"/);

  const reviewDefault = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'edit',
      reviewRequired: true,
      draft: projectFormDraft({ id: 'example', name: 'Example' }),
      formErrors: {}
    }
  });
  assert.doesNotMatch(reviewDefault.app.innerHTML, /class="launch-profile-editor"/);

  const addWithProfiles = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'add',
      draft: projectFormDraft({
        launchProfiles: [{
          id: 'tests',
          name: 'Tests',
          startCommand: 'npm test',
          stopCommand: '',
          services: []
        }]
      }),
      formErrors: {}
    }
  });
  assert.match(addWithProfiles.app.innerHTML, /class="launch-profile-editor"/);
});

test('Add form shows Start and Dev chips that fill the command without starting', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'add',
      draft: projectFormDraft({ startCommand: '' }),
      draftStartScripts: [
        { name: 'start', startCommand: 'npm start' },
        { name: 'dev', startCommand: 'npm run dev' }
      ],
      draftStartCommandNotice: 'Start command set to npm start.',
      formErrors: {}
    }
  });

  assert.match(result.app.innerHTML, /<h2>Add this folder<\/h2>/);
  assert.match(result.app.innerHTML, /id="start-command"/);
  assert.match(result.app.innerHTML, /class="empty-start-chips draft-start-chips"/);
  assert.match(result.app.innerHTML, /role="group" aria-label="Suggested start commands for this folder"/);
  assert.match(result.app.innerHTML, /data-action="use-draft-start-script" data-script="start"/);
  assert.match(result.app.innerHTML, /data-action="use-draft-start-script" data-script="dev"/);
  assert.match(result.app.innerHTML, /aria-label="Use npm start for the start command"/);
  assert.match(result.app.innerHTML, /aria-label="Use npm run dev for the start command"/);
  assert.match(result.app.innerHTML, /title="Use \u201Cnpm start\u201D"/);
  assert.match(result.app.innerHTML, />\s*Start\s*</);
  assert.match(result.app.innerHTML, />\s*Dev\s*</);
  assert.match(result.app.innerHTML, /role="status">Start command set to npm start\.</);
  assert.doesNotMatch(result.app.innerHTML, /data-action="start-workspace-script"/);
  assert.doesNotMatch(result.app.innerHTML, /class="empty-state"/);
});

test('Add form hides Start/Dev chips when the folder has no npm scripts', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'add',
      draft: projectFormDraft({ startCommand: '' }),
      draftStartScripts: [],
      formErrors: {}
    }
  });

  assert.match(result.app.innerHTML, /<h2>Add this folder<\/h2>/);
  assert.doesNotMatch(result.app.innerHTML, /draft-start-chips/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="use-draft-start-script"/);
  assert.doesNotMatch(result.app.innerHTML, /Suggested start commands for this folder/);
});

test('Edit and Review setup screens do not show Add-form start chips', () => {
  const edit = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'edit',
      reviewRequired: false,
      draft: projectFormDraft({ id: 'example', name: 'Example' }),
      draftStartScripts: [
        { name: 'start', startCommand: 'npm start' },
        { name: 'dev', startCommand: 'npm run dev' }
      ],
      formErrors: {}
    }
  });
  assert.match(edit.app.innerHTML, /<h2>Edit project<\/h2>/);
  assert.doesNotMatch(edit.app.innerHTML, /draft-start-chips/);
  assert.doesNotMatch(edit.app.innerHTML, /data-action="use-draft-start-script"/);

  const review = renderNonEmptyProjectList([], {
    stateOverrides: {
      mode: 'edit',
      reviewRequired: true,
      draft: projectFormDraft({ id: 'example', name: 'Example' }),
      draftStartScripts: [
        { name: 'start', startCommand: 'npm start' }
      ],
      formErrors: {}
    }
  });
  assert.match(review.app.innerHTML, /<h2>Review project setup<\/h2>/);
  assert.doesNotMatch(review.app.innerHTML, /draft-start-chips/);
  assert.doesNotMatch(review.app.innerHTML, /data-action="use-draft-start-script"/);
});

test('renders everyday project rows without a competing folder path', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/northstar-dashboard',
    id: 'northstar',
    launchProfiles: [],
    name: 'Northstar Dashboard',
    openPorts: [4310],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 4310 }],
    status: 'running',
    tags: []
  }], {
    stateOverrides: {
      stopAllCount: 2,
      workspaceStartScripts: [
        { name: 'start', startCommand: 'npm start' },
        { name: 'dev', startCommand: 'npm run dev' }
      ]
    }
  });

  assert.match(result.app.innerHTML, /<h2 id="project-northstar"[^>]*>[\s\S]*Northstar Dashboard\s*<\/h2>/);
  assert.match(result.app.innerHTML, /class="project-meta"/);
  assert.match(result.app.innerHTML, /class="project-status status-running"[^>]*>[\s\S]*<span>Running<\/span>/);
  assert.match(result.app.innerHTML, /class="project-port-chip"[^>]*>[\s\S]*:4310/);
  assert.match(result.app.innerHTML, /class="run-button restart"[^>]*aria-label="Restart Northstar Dashboard"/);
  assert.match(result.app.innerHTML, /class="visually-hidden">\/Users\/shared\/Projects\/northstar-dashboard/);
  assert.match(result.app.innerHTML, /data-action="stop-all"/);
  assert.match(result.app.innerHTML, /Stop all \(2\)/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="start-workspace-script"/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="use-draft-start-script"/);
  assert.doesNotMatch(result.app.innerHTML, /class="detail-row"/);
  assert.doesNotMatch(result.app.innerHTML, /Services · 1/);
  assert.doesNotMatch(result.app.innerHTML, /web :4310/);
  assert.doesNotMatch(result.app.innerHTML, /class="project-readiness-detail"/);
  assert.doesNotMatch(result.app.innerHTML, /class="auto-scroll"><span class="auto-scroll-content">Northstar Dashboard/);
});

test('running row shows elapsed from the live timeline on line 2', () => {
  const launchedAt = Date.now() - 65_000;
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/northstar-dashboard',
    id: 'northstar',
    launchProfiles: [],
    name: 'Northstar Dashboard',
    openPorts: [4310],
    pinned: false,
    previewExpanded: false,
    previewUrl: 'http://localhost:4310',
    previewPort: 4310,
    reviewRequired: false,
    services: [{ name: 'web', port: 4310 }],
    status: 'running',
    tags: [],
    timeline: { launchedAt, readyAt: launchedAt + 1200 }
  }]);

  assert.match(result.app.innerHTML, /class="project-status status-running"[^>]*>[\s\S]*<span>Running<\/span>/);
  assert.match(result.app.innerHTML, /class="project-row-elapsed" data-row-elapsed data-started-at="/);
  assert.match(result.app.innerHTML, /aria-label="Running for 1m 0?5s"/);
  assert.match(result.app.innerHTML, /class="project-port-chip is-openable"[^>]*>[\s\S]*:4310[\s\S]*class="project-open-label">Open/);
  assert.doesNotMatch(result.app.innerHTML, /class="project-readiness-detail"/);
});

test('stopped rows do not show elapsed time', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/northstar-dashboard',
    id: 'northstar',
    launchProfiles: [],
    name: 'Northstar Dashboard',
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 4310 }],
    status: 'stopped',
    tags: [],
    timeline: { launchedAt: Date.now() - 10_000, readyAt: Date.now() - 9_000 }
  }]);

  assert.doesNotMatch(result.app.innerHTML, /data-row-elapsed/);
  assert.match(result.app.innerHTML, /class="project-port-chip"/);
});

test('renders Detected on the status line without a second Detected running sentence', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    currentWorkspace: true,
    detailsExpanded: false,
    folder: '/Users/shared/Projects/northstar-dashboard',
    id: 'northstar',
    launchProfiles: [],
    name: 'Northstar Dashboard',
    openPorts: [4310],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 4310 }],
    status: 'active',
    stopCommand: 'docker compose down',
    tags: []
  }]);

  assert.match(result.app.innerHTML, /Northstar Dashboard\s*<\/h2>/);
  assert.match(result.app.innerHTML, /class="project-status status-active"[^>]*>[\s\S]*<span>Detected<\/span>/);
  assert.match(result.app.innerHTML, /class="project-port-chip"[^>]*>[\s\S]*:4310/);
  assert.doesNotMatch(result.app.innerHTML, /Detected running/);
  assert.doesNotMatch(result.app.innerHTML, /class="project-readiness-detail"/);
  assert.doesNotMatch(result.app.innerHTML, /class="current-window-label"/);
  assert.match(result.app.innerHTML, /role="menuitem" disabled>[\s\S]*This window/);
});

test('detected apps without a stop command offer Add stop command and keep close-ports in More', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    currentWorkspace: true,
    detailsExpanded: false,
    folder: '/Users/shared/Projects/northstar-dashboard',
    id: 'northstar',
    launchProfiles: [],
    name: 'Northstar Dashboard',
    openPorts: [4310],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 4310 }],
    status: 'active',
    tags: []
  }]);

  assert.match(
    result.app.innerHTML,
    /class="project-status status-active"[^>]*title="Runlist detected this app on a configured port but did not start it\."[^>]*>[\s\S]*<span>Running elsewhere<\/span>/
  );
  assert.match(
    result.app.innerHTML,
    /class="run-button review"[^>]*data-action="add-stop-command"[^>]*aria-label="Add a stop command for Northstar Dashboard"/
  );
  assert.match(
    result.app.innerHTML,
    /data-action="add-stop-command" data-id="northstar" role="menuitem" aria-label="Add a stop command for Northstar Dashboard"/
  );
  assert.match(
    result.app.innerHTML,
    /data-action="force-close-ports" data-id="northstar" role="menuitem"/
  );
  assert.doesNotMatch(result.app.innerHTML, /data-action="force-close-ports"[^>]*class="run-button"/);
  assert.doesNotMatch(result.app.innerHTML, /Close processes using/);
  assert.doesNotMatch(result.app.innerHTML, /Detected running/);
});

test('review setup stays primary and hides Add stop command until review is done', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/northstar-dashboard',
    id: 'northstar',
    launchProfiles: [],
    name: 'Northstar Dashboard',
    openPorts: [4310],
    pinned: false,
    previewExpanded: false,
    reviewRequired: true,
    services: [{ name: 'web', port: 4310 }],
    status: 'active',
    tags: []
  }]);

  assert.match(result.app.innerHTML, /data-action="edit"[^>]*aria-label="Review setup for Northstar Dashboard"/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="add-stop-command"/);
});

test('failed start keeps a two-line row with the reason and View output', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    failureSummary: {
      title: 'Start failed',
      message: '/bin/sh: vite: command not found'
    },
    folder: '/Users/shared/Projects/broken-app',
    id: 'broken',
    launchProfiles: [],
    name: 'Broken App',
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }],
    status: 'stopped',
    tags: []
  }]);

  assert.match(result.app.innerHTML, /<h2 id="project-broken"[^>]*>[\s\S]*Broken App\s*<\/h2>/);
  assert.match(
    result.app.innerHTML,
    /class="project-status status-start-failed"[^>]*title="\/bin\/sh: vite: command not found"[^>]*>[\s\S]*<span>Start failed<\/span>/
  );
  assert.match(result.app.innerHTML, /class="run-button output"[^>]*data-action="output"[^>]*aria-label="View output for Broken App"/);
  assert.match(result.app.innerHTML, /data-action="start"[^>]*role="menuitem"[^>]*aria-label="Start Broken App"/);
  assert.doesNotMatch(result.app.innerHTML, />Stopped</);
  assert.doesNotMatch(result.app.innerHTML, />Running</);
  assert.doesNotMatch(result.app.innerHTML, /class="project-readiness-detail"/);
  assert.doesNotMatch(result.app.innerHTML, /class="run-button start"[^>]*data-action="start"/);
  assert.doesNotMatch(result.app.innerHTML, /Ask your agent|copy-diagnosis-request/);
});

test('missing-required-env start failure uses Fix environment as the primary row action', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    failureSummary: {
      title: 'Start failed',
      message: 'Required environment variables are not set for this launch profile. Missing: API_KEY, DATABASE_URL.',
      kind: 'missing-required-env'
    },
    folder: '/Users/shared/Projects/api',
    id: 'api',
    launchProfiles: [],
    name: 'API',
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }],
    status: 'stopped',
    tags: []
  }]);

  assert.match(
    result.app.innerHTML,
    /class="project-status status-start-failed"[^>]*title="Add the missing environment variables, then try Start again\."[^>]*>[\s\S]*<span>Start failed<\/span>/
  );
  assert.match(
    result.app.innerHTML,
    /class="run-button review"[^>]*data-action="fix-environment"[^>]*data-id="api"[^>]*data-focus-target="env-map"[^>]*aria-label="Fix environment setup for API"/
  );
  assert.match(result.app.innerHTML, /data-action="edit"[^>]*role="menuitem">[\s\S]*Edit project/);
  assert.doesNotMatch(result.app.innerHTML, /class="run-button start"/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="fix-environment"[^>]*role="menuitem"/);
});

test('stop honesty uses View output primary with Stop in More and does not say Stopped while a port is up', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/live-app',
    id: 'live',
    launchProfiles: [],
    name: 'Live App',
    openPorts: [3000],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }],
    status: 'running',
    stopFailure: 'Port :3000 is still up',
    tags: []
  }]);

  assert.match(result.app.innerHTML, /<h2 id="project-live"[^>]*>[\s\S]*Live App\s*<\/h2>/);
  assert.match(
    result.app.innerHTML,
    /class="project-status status-stop-failed"[^>]*>[\s\S]*<span>Port :3000 is still up<\/span>/
  );
  assert.match(
    result.app.innerHTML,
    /class="run-button output"[^>]*data-action="output"[^>]*aria-label="View output for Live App"/
  );
  assert.match(
    result.app.innerHTML,
    /data-action="stop" data-id="live" role="menuitem"[^>]*aria-label="Stop Live App"/
  );
  assert.match(result.app.innerHTML, /data-action="force-close-ports"/);
  assert.doesNotMatch(result.app.innerHTML, /class="run-button stop"[^>]*data-action="stop"/);
  assert.doesNotMatch(result.app.innerHTML, />Stopped</);
  assert.doesNotMatch(result.app.innerHTML, /class="project-readiness-detail"/);
});

function sampleProject(id, name, extras = {}) {
  return {
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: `C:\\Projects\\${id}`,
    id,
    launchProfiles: [],
    name,
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [],
    status: 'stopped',
    tags: extras.tags || [],
    ...extras
  };
}

test('missing folder shows Folder missing and Choose folder without Start', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/moved-app',
    folderAccessible: false,
    id: 'moved',
    launchProfiles: [],
    name: 'Moved App',
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [],
    status: 'stopped',
    tags: []
  }]);

  assert.match(
    result.app.innerHTML,
    /class="project-status status-folder-missing"[^>]*>[\s\S]*<span>Folder missing<\/span>/
  );
  assert.match(
    result.app.innerHTML,
    /class="run-button relink"[^>]*data-action="relink-folder"[^>]*aria-label="Choose a new folder for Moved App"/
  );
  assert.match(result.app.innerHTML, /data-action="relink-folder"[^>]*role="menuitem"[^>]*>[\s\S]*Choose folder/);
  assert.match(result.app.innerHTML, /data-action="delete"[^>]*role="menuitem"/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="start"/);
  assert.doesNotMatch(result.app.innerHTML, /class="run-button restart"/);
  assert.doesNotMatch(result.app.innerHTML, />Stopped</);
});

test('Compose missing-folder rows keep Edit project instead of Choose folder', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    composePath: '/Users/shared/Projects/compose-app/compose.yaml',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/compose-app',
    folderAccessible: false,
    id: 'compose',
    launchProfiles: [],
    name: 'Compose App',
    openPorts: [],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [],
    status: 'stopped',
    tags: []
  }]);

  assert.match(
    result.app.innerHTML,
    /class="project-status status-folder-missing"[^>]*>[\s\S]*<span>Folder missing<\/span>/
  );
  assert.match(
    result.app.innerHTML,
    /class="run-button review"[^>]*data-action="edit"[^>]*aria-label="Edit Compose App to update its folder"/
  );
  assert.doesNotMatch(result.app.innerHTML, /data-action="relink-folder"/);
  assert.match(result.app.innerHTML, /data-action="delete"[^>]*role="menuitem"/);
});

test('running rows with a missing folder keep Stop instead of Choose folder', () => {
  const result = renderNonEmptyProjectList([{
    activeLaunchProfileId: 'default',
    activeLaunchProfileName: 'Default',
    detailsExpanded: false,
    folder: '/Users/shared/Projects/live-moved',
    folderAccessible: false,
    id: 'live-moved',
    launchProfiles: [],
    name: 'Live Moved',
    openPorts: [3000],
    pinned: false,
    previewExpanded: false,
    reviewRequired: false,
    services: [{ name: 'web', port: 3000 }],
    status: 'running',
    tags: []
  }]);

  assert.match(result.app.innerHTML, /<span>Running<\/span>/);
  assert.match(result.app.innerHTML, /data-action="stop"[^>]*aria-label="Stop Live Moved"/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="relink-folder"/);
  assert.doesNotMatch(result.app.innerHTML, />Folder missing</);
});

test('active filters with zero matches show help text and Clear filters', () => {
  const result = renderNonEmptyProjectList([
    sampleProject('frontend', 'Frontend app', { tags: ['frontend'] }),
    sampleProject('docs', 'Docs', { tags: ['docs'] })
  ], {
    stateOverrides: {
      tags: ['docs', 'frontend'],
      groups: [{ id: 'dev-stack', name: 'Dev stack', projectIds: ['frontend'] }]
    },
    persistedWebviewState: {
      filterRevision: 1,
      groupFilter: 'dev-stack',
      searchQuery: 'zzzz-no-match',
      tagFilter: 'frontend'
    }
  });

  assert.match(result.app.innerHTML, /data-search-empty/);
  assert.match(result.app.innerHTML, /Try a different search or clear your filters\./);
  assert.match(result.app.innerHTML, /data-action="clear-filters"[^>]*aria-label="Clear search, tag, and group filters"/);
  assert.match(result.app.innerHTML, />Clear filters</);
  assert.equal(result.searchEmpty.hidden, false);
  assert.deepEqual(result.projectRows.map((row) => row.hidden), [true, true]);
  assert.match(result.projectCount.innerHTML, /<strong>0<\/strong> of 2 projects/);
});

test('Clear filters resets search, tag, and group filters and unhides rows', () => {
  const result = renderNonEmptyProjectList([
    sampleProject('frontend', 'Frontend app', { tags: ['frontend'] }),
    sampleProject('docs', 'Docs', { tags: ['docs'] })
  ], {
    stateOverrides: {
      tags: ['docs', 'frontend'],
      groups: [{ id: 'dev-stack', name: 'Dev stack', projectIds: ['frontend'] }]
    },
    persistedWebviewState: {
      filterRevision: 1,
      groupFilter: 'dev-stack',
      searchQuery: 'zzzz-no-match',
      tagFilter: 'frontend'
    }
  });

  assert.equal(result.evaluate('searchQuery'), 'zzzz-no-match');
  assert.equal(result.evaluate('selectedTagFilter'), 'frontend');
  assert.equal(result.evaluate('selectedGroupFilter'), 'dev-stack');
  assert.equal(result.searchEmpty.hidden, false);
  const scheduledBefore = result.scheduledFrames.length;

  result.evaluate('handleClearFilters()');
  const addedFrames = result.scheduledFrames.slice(scheduledBefore);
  for (const frame of addedFrames) {
    frame();
  }

  assert.equal(result.evaluate('searchQuery'), '');
  assert.equal(result.evaluate('selectedTagFilter'), '');
  assert.equal(result.evaluate('selectedGroupFilter'), '');
  assert.equal(result.searchInput.value, '');
  assert.ok(result.searchInput.focusCount >= 1);
  assert.equal(result.searchStatus.textContent, 'No projects match. Filters cleared.');
  assert.equal(result.searchEmpty.hidden, true);
  assert.deepEqual(result.projectRows.map((row) => row.hidden), [false, false]);
  assert.match(result.projectCount.innerHTML, /<strong>2<\/strong> projects/);
  assert.ok(result.postedMessages.some((message) => (
    message.type === 'setSearchQuery'
    && message.query === ''
    && message.tag === ''
  )));
  assert.equal(result.savedStates.at(-1)?.groupFilter, '');
  assert.equal(result.savedStates.at(-1)?.searchQuery, '');
  assert.equal(result.savedStates.at(-1)?.tagFilter, '');
  assert.doesNotMatch(result.app.innerHTML, /class="active-tag-chip"/);
  assert.doesNotMatch(result.app.innerHTML, /class="active-group-chip"/);
});

test('unfiltered empty project list does not show search-empty', () => {
  const result = renderNonEmptyProjectList([], {
    stateOverrides: {
      currentWorkspaceFolder: 'C:\\Projects\\app',
      currentWorkspaceFolderName: 'app'
    }
  });

  assert.match(result.app.innerHTML, /No projects yet/);
  assert.doesNotMatch(result.app.innerHTML, /data-search-empty/);
  assert.doesNotMatch(result.app.innerHTML, /data-action="clear-filters"/);
  assert.doesNotMatch(result.app.innerHTML, /No matching projects/);
});

test('typing in search does not announce the Clear filters recovery message', () => {
  const result = renderNonEmptyProjectList([
    sampleProject('frontend', 'Frontend app'),
    sampleProject('docs', 'Docs')
  ]);

  result.evaluate(`
    searchQuery = 'zzzz-no-match';
    applyProjectFilter(searchQuery);
  `);

  assert.match(result.searchStatus.textContent, /0 projects shown/);
  assert.notEqual(result.searchStatus.textContent, 'No projects match. Filters cleared.');
});

test('group failure names the blocking project and offers focus control', () => {
  const result = renderNonEmptyProjectList([
    sampleProject('alpha', 'Alpha app', { tags: ['frontend'] }),
    sampleProject('beta', 'Beta API', { tags: ['backend'] })
  ], {
    stateOverrides: {
      groups: [{
        id: 'daily',
        name: 'Daily stack',
        projectIds: ['alpha', 'beta'],
        progress: 'Blocked by Beta API. The project is port-in-use and cannot be started safely.',
        blockingProjectId: 'beta',
        blockingProjectName: 'Beta API'
      }]
    },
    persistedWebviewState: { groupsExpanded: true }
  });

  assert.match(result.app.innerHTML, /Blocked by Beta API\. The project is port-in-use/);
  assert.match(result.app.innerHTML, /data-action="focus-group-blocking"[^>]*data-project-id="beta"/);
  assert.match(result.app.innerHTML, /aria-label="Show Beta API"/);
});

test('focus-group-blocking clears filters when the blocking row is hidden', () => {
  const projects = [
    sampleProject('alpha', 'Alpha app', { tags: ['frontend'] }),
    sampleProject('beta', 'Beta API', { tags: ['backend'] })
  ];
  const result = renderNonEmptyProjectList(projects, {
    stateOverrides: {
      tags: ['frontend', 'backend'],
      groups: [{
        id: 'daily',
        name: 'Daily stack',
        projectIds: ['alpha', 'beta'],
        progress: 'Blocked by Beta API. Runlist blocked or could not start this project.',
        blockingProjectId: 'beta',
        blockingProjectName: 'Beta API'
      }]
    },
    persistedWebviewState: {
      groupsExpanded: true,
      tagFilter: 'frontend',
      filterRevision: 1
    }
  });

  assert.equal(result.evaluate('selectedTagFilter'), 'frontend');
  assert.equal(result.projectRows.find((row) => row.dataset.projectId === 'beta').hidden, true);

  result.evaluate('focusGroupBlockingProject("beta")');
  const addedFrames = result.scheduledFrames.slice();
  for (const frame of addedFrames) {
    frame();
  }

  assert.equal(result.evaluate('selectedTagFilter'), '');
  assert.equal(result.projectRows.find((row) => row.dataset.projectId === 'beta').hidden, false);
  assert.equal(result.lifecycleStatus.textContent, 'Focused Beta API.');
});
