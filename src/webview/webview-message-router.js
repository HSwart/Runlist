const { createWebviewCommandRouter } = require('../../media/message-router');

function createRunlistWebviewRouter(host, adapters = {}) {
  const updateFilterState = (message, field) => {
    if (message.filterRevision !== undefined
      && (!Number.isSafeInteger(message.filterRevision) || message.filterRevision < 0)) {
      return;
    }
    if (field === 'search'
      && message.tag !== undefined
      && (typeof message.tag !== 'string' || message.tag.length > 32)) {
      return;
    }
    if (field === 'tag'
      && message.query !== undefined
      && (typeof message.query !== 'string' || message.query.length > 1000)) {
      return;
    }
    const incomingRevision = message.filterRevision;
    const versioned = incomingRevision !== undefined;
    if (versioned
      && (message.query === undefined
        || message.tag === undefined
        || !Number.isInteger(message.selectionStart)
        || !Number.isInteger(message.selectionEnd)
        || typeof message.searchFocused !== 'boolean')) {
      return;
    }
    const query = field === 'search' || message.query !== undefined
      ? normalizeFilterQuery(message.query)
      : normalizeFilterQuery(host.searchQuery);
    const tag = field === 'tag' || message.tag !== undefined
      ? normalizeFilterTag(message.tag)
      : normalizeFilterTag(host.tagFilter);
    const selection = versioned
      ? normalizeSelection(message.selectionStart, message.selectionEnd, query.length, message.searchFocused)
      : { start: 0, end: 0, focused: false };
    if (!selection) {
      return;
    }
    const currentRevision = Number.isSafeInteger(host.filterRevision)
      ? host.filterRevision
      : 0;
    const hasVersionedState = host.filterRevisionSeen === true
      || currentRevision > 0;
    if (!versioned && hasVersionedState) {
      return;
    }
    if (versioned && incomingRevision < currentRevision) {
      return;
    }
    const currentSelection = {
      start: Number.isInteger(host.searchSelectionStart) ? host.searchSelectionStart : 0,
      end: Number.isInteger(host.searchSelectionEnd) ? host.searchSelectionEnd : 0,
      focused: host.searchFocused === true
    };
    const currentState = {
      query: normalizeFilterQuery(host.searchQuery),
      tag: normalizeFilterTag(host.tagFilter),
      selection: currentSelection
    };
    const nextState = {
      query,
      tag,
      selection
    };
    const sameState = currentState.query === nextState.query
      && currentState.tag === nextState.tag
      && currentState.selection.start === nextState.selection.start
      && currentState.selection.end === nextState.selection.end
      && currentState.selection.focused === nextState.selection.focused;
    if (versioned && incomingRevision === currentRevision) {
      return;
    }
    if (!versioned && sameState) {
      return;
    }
    host.filterRevision = versioned ? incomingRevision : currentRevision;
    host.filterRevisionSeen = versioned || hasVersionedState;
    host.searchQuery = query;
    host.tagFilter = tag;
    host.searchSelectionStart = selection.start;
    host.searchSelectionEnd = selection.end;
    host.searchFocused = selection.focused;
    host.renderProjectList?.();
  };

  const route = createWebviewCommandRouter({
    handlers: {
      approveProjectRepair: (message) => host.approveProjectRepair(message.proposalId),
      approveComposeImport: () => host.approveComposeImport(),
      closeScreen: (message) => host.closeScreen(message.draft),
      copyDiagnosisRequest: () => host.copyDiagnosisRequest(),
      copyOutput: () => host.copyProjectOutput(),
      copyPhoneUrl: (message) => host.copyPhoneUrl(message.id, message.url),
      copyProjectPath: (message) => host.copyProjectPath(message.id),
      copyServiceUrl: (message) => host.copyServiceUrl(message.id, Number(message.port)),
      deleteProject: (message) => host.deleteProject(message.id),
      forceCloseProjectPorts: (message) => {
        const port = Number(message.port);
        const options = Number.isInteger(port) && port >= 1 && port <= 65535
          ? { servicePort: port }
          : {};
        return host.forceCloseProjectPorts(message.id, 'stop', options);
      },
      forceCloseProjectPortsAndStart: (message) => host.forceCloseProjectPorts(message.id, 'start'),
      handoffProject: (message) => host.handoffProject(message.id),
      manageRunGroups: (message) => host.showRunGroupManager(message.id),
      saveRunGroup: (message) => host.saveRunGroupFromEditor(message.group),
      removeRunGroup: (message) => host.removeRunGroupFromEditor(message.id),
      openOutputUrl: (message) => host.openOutputUrl(message.url),
      openProject: (message) => host.openProject(message.id),
      openServiceUrl: (message) => host.openServiceUrl(message.id, Number(message.port)),
      openProjectFolder: (message) => host.openProjectFolder(message.id),
      openProjectTerminal: (message) => host.openProjectTerminal(message.id),
      pickFolder: (message) => host.pickFolder(message.draft),
      refreshProjectRepair: () => host.refreshProjectRepair(),
      refreshPortListening: () => host.refreshPortListeningDiagnosis(),
      registerAgent: (message) => host.registerAgent(message.agent),
      rejectProjectRepair: () => host.rejectProjectRepair(),
      resolveServicePort: (message) => host.resolveServicePort(message.id, Number(message.port)),
      choosePortResolve: (message) => host.choosePortResolve(message.action),
      revealPortOwnerProject: (message) => host.revealPortOwnerProject(message.id),
      showComposeImport: (message) => host.showComposeImport(message.id),
      restartProject: (message) => host.restartProject(message.id),
      retryProjectRepair: () => host.retryProjectRepair(),
      saveProject: (message) => host.saveProject(message.project),
      setFocusTarget: (message) => {
        const target = adapters.validFocusTarget(message.target);
        host.lastFocusTarget = target;
        if (target?.type === 'field' && target.id === 'project-search') {
          host.searchFocused = true;
        } else if (target) {
          host.searchFocused = false;
        }
      },
      setSearchQuery: (message) => {
        updateFilterState(message, 'search');
      },
      setRunGroupStartMode: (message) => host.setRunGroupStartMode(message.id, message.startMode),
      selectLaunchProfile: (message) => host.selectLaunchProfile(message.id, message.profileId),
      setTagFilter: (message) => {
        updateFilterState(message, 'tag');
      },
      showAdd: () => host.showAddProject({ type: 'action', action: 'show-add' }),
      showAgentSetup: () => host.showAgentSetup(),
      loadWorkspaceStack: () => host.showProjectTransferLoadStack(),
      approveStackReview: () => host.approveStackReview(),
      selectWorkspaceFolder: (message) => host.selectPreferredWorkspaceFolder(message.folder),
      showPortListening: () => host.showPortListeningDiagnosis(),
      copyPortListeningDetails: (message) => host.copyPortListeningDetails(message.port),
      startWorkspaceScript: (message) => host.startWorkspaceScript(message.script),
      showDiagnosis: (message) => host.showProjectDiagnosis(message.id),
      showEdit: (message) => host.showEditProject(message.id),
      showOutput: (message) => {
        if (message.projectIncarnation !== undefined
          && !validProjectIncarnation(message.projectIncarnation)) {
          return;
        }
        return host.showProjectOutput(message.id, message.projectIncarnation);
      },
      startProject: (message) => host.startProject(message.id),
      startRunGroup: (message) => host.startSavedRunGroup(message.id),
      stopAllProjects: () => host.stopAllProjects(),
      stopProject: (message) => host.stopProject(message.id),
      stopRunGroup: (message) => host.stopSavedRunGroup(message.id),
      toggleProjectPin: (message) => host.toggleProjectPin(message.id),
      toggleProjectPreview: (message) => host.toggleProjectPreview(
        message.id,
        typeof message.focusAction === 'string' && message.focusAction.trim()
          ? message.focusAction.trim()
          : 'toggle-preview'
      ),
      toggleProjectServices: (message) => host.toggleProjectPreview(message.id, 'open-services'),
      updateDraft: (message) => {
        if (['add', 'edit'].includes(host.mode)) {
          host.draft = adapters.projectFormValues(message.draft);
        }
      },
      useCurrentWorkspace: (message) => host.useCurrentWorkspace(message.draft)
    }
  });
  return async (message) => {
    if (message?.type === 'showOutput'
      && message.projectIncarnation !== undefined
      && !validProjectIncarnation(message.projectIncarnation)) {
      return false;
    }
    return route(message);
  };
}

module.exports = { createRunlistWebviewRouter };

function normalizeFilterQuery(value) {
  return String(value || '');
}

function normalizeFilterTag(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSelection(start, end, queryLength, focused) {
  if (!Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || end > queryLength
    || typeof focused !== 'boolean') {
    return undefined;
  }
  return { start, end, focused };
}

function validProjectIncarnation(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
