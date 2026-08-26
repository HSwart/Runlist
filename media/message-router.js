(function exposeMessageRouter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.RunlistMessageRouter = api;
  }
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const WEBVIEW_MESSAGE_TYPES = new Set([
    'diagnosisRequestCopied',
    'outputCopied',
    'projectHttpPulse',
    'projectMetrics',
    'projectOutput',
    'projectOutputPeek',
    'restoreProjectMenuFocus'
  ]);
  const WEBVIEW_COMMAND_TYPES = new Set([
    'approveProjectRepair',
    'approveComposeImport',
    'closeScreen',
    'copyDiagnosisRequest',
    'copyOutput',
    'copyPhoneUrl',
    'copyProjectPath',
    'copyServiceUrl',
    'deleteProject',
    'forceCloseProjectPorts',
    'forceCloseProjectPortsAndStart',
    'handoffProject',
    'manageRunGroups',
    'openOutputUrl',
    'openProject',
    'openServiceUrl',
    'openProjectFolder',
    'openProjectTerminal',
    'pickFolder',
    'refreshProjectRepair',
    'registerAgent',
    'rejectProjectRepair',
    'resolveServicePort',
    'restartProject',
    'retryProjectRepair',
    'saveProject',
    'setFocusTarget',
    'setSearchQuery',
    'setRunGroupStartMode',
    'selectLaunchProfile',
    'setTagFilter',
    'showAdd',
    'showAgentSetup',
    'showPortListening',
    'showComposeImport',
    'refreshPortListening',
    'copyPortListeningDetails',
    'revealPortOwnerProject',
    'showDiagnosis',
    'showEdit',
    'showOutput',
    'startProject',
    'startRunGroup',
    'startWorkspaceScript',
    'stopAllProjects',
    'stopProject',
    'stopRunGroup',
    'toggleProjectPin',
    'toggleProjectPreview',
    'toggleProjectServices',
    'updateDraft',
    'useCurrentWorkspace'
  ]);
  const ID_COMMAND_TYPES = new Set([
    'copyProjectPath',
    'deleteProject',
    'forceCloseProjectPorts',
    'forceCloseProjectPortsAndStart',
    'handoffProject',
    'revealPortOwnerProject',
    'openProject',
    'openProjectFolder',
    'openProjectTerminal',
    'resolveServicePort',
    'restartProject',
    'showDiagnosis',
    'showEdit',
    'showOutput',
    'setRunGroupStartMode',
    'startProject',
    'startRunGroup',
    'stopProject',
    'stopRunGroup',
    'toggleProjectPin',
    'toggleProjectPreview',
    'toggleProjectServices'
  ]);

  function validateWebviewCommand(value) {
    if (!isRecord(value) || !WEBVIEW_COMMAND_TYPES.has(value.type)) {
      return undefined;
    }
    if (ID_COMMAND_TYPES.has(value.type) && !validId(value.id)) {
      return undefined;
    }
    if (value.type === 'manageRunGroups'
      && value.id !== undefined
      && !validId(value.id)) {
      return undefined;
    }
    if (['closeScreen', 'pickFolder', 'useCurrentWorkspace'].includes(value.type)
      && value.draft !== undefined
      && !isRecord(value.draft)) {
      return undefined;
    }
    if (value.type === 'saveProject' && !isRecord(value.project)) {
      return undefined;
    }
    if (value.type === 'updateDraft' && !isRecord(value.draft)) {
      return undefined;
    }
    if (value.type === 'setFocusTarget' && !isRecord(value.target)) {
      return undefined;
    }
    if (value.type === 'setSearchQuery'
      && (typeof value.query !== 'string' || value.query.length > 1000)) {
      return undefined;
    }
    if (value.type === 'selectLaunchProfile'
      && (!validId(value.id) || !validId(value.profileId))) {
      return undefined;
    }
    if (value.type === 'setRunGroupStartMode'
      && (!validId(value.id) || !['sequential', 'parallel'].includes(value.startMode))) {
      return undefined;
    }
    if (value.type === 'setTagFilter'
      && (typeof value.tag !== 'string' || value.tag.length > 32)) {
      return undefined;
    }
    if (value.type === 'registerAgent'
      && !['claude', 'codex', 'copilot'].includes(value.agent)) {
      return undefined;
    }
    if (value.type === 'startWorkspaceScript'
      && !['start', 'dev'].includes(value.script)) {
      return undefined;
    }
    if (['copyServiceUrl', 'openServiceUrl'].includes(value.type)
      && (!validId(value.id)
        || !Number.isInteger(Number(value.port))
        || Number(value.port) < 1
        || Number(value.port) > 65535)) {
      return undefined;
    }
    if (value.type === 'resolveServicePort'
      && (!Number.isInteger(Number(value.port))
        || Number(value.port) < 1
        || Number(value.port) > 65535)) {
      return undefined;
    }
    if (value.type === 'forceCloseProjectPorts'
      && value.port !== undefined
      && (!Number.isInteger(Number(value.port))
        || Number(value.port) < 1
        || Number(value.port) > 65535)) {
      return undefined;
    }
    if (value.type === 'copyPortListeningDetails'
      && value.port !== undefined
      && (!Number.isInteger(Number(value.port))
        || Number(value.port) < 1
        || Number(value.port) > 65535)) {
      return undefined;
    }
    if (value.type === 'copyPhoneUrl'
      && (!validId(value.id) || !validText(value.url, 4096))) {
      return undefined;
    }
    if (value.type === 'openOutputUrl' && !validText(value.url, 4096)) {
      return undefined;
    }
    return value;
  }

  function createWebviewCommandRouter({ handlers }) {
    const allowedHandlers = isRecord(handlers) ? handlers : {};
    return async (value) => {
      const message = validateWebviewCommand(value);
      const handler = message && allowedHandlers[message.type];
      if (typeof handler !== 'function') {
        return false;
      }
      await handler(message);
      return true;
    };
  }

  function validateWebviewMessage(value, messageToken) {
    if (!isRecord(value)
      || value.messageToken !== messageToken
      || !WEBVIEW_MESSAGE_TYPES.has(value.type)) {
      return undefined;
    }
    if (['projectHttpPulse', 'projectMetrics', 'projectOutputPeek', 'restoreProjectMenuFocus']
      .includes(value.type) && !validId(value.id)) {
      return undefined;
    }
    if (value.type === 'projectOutputPeek' && !validOutputEntries(value.entries)) {
      return undefined;
    }
    if (value.type === 'projectOutput'
      && (!validOutputEntries(value.entries) || typeof value.output !== 'string')) {
      return undefined;
    }
    if (value.type === 'projectMetrics'
      && (!optionalRecord(value.metrics)
        || !optionalArray(value.runtimePulse)
        || !optionalArray(value.httpResponsePulse))) {
      return undefined;
    }
    if (value.type === 'projectHttpPulse' && !optionalArray(value.httpResponsePulse)) {
      return undefined;
    }
    return value;
  }

  function createWebviewMessageRouter({ messageToken, handlers }) {
    const allowedHandlers = isRecord(handlers) ? handlers : {};
    return (event) => {
      const message = validateWebviewMessage(event?.data, messageToken);
      const handler = message && allowedHandlers[message.type];
      if (typeof handler !== 'function') {
        return false;
      }
      handler(message);
      return true;
    };
  }

  function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
  }

  function validText(value, maximumLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
  }

  function optionalRecord(value) {
    return value === undefined || value === null || isRecord(value);
  }

  function optionalArray(value) {
    return value === undefined || value === null || Array.isArray(value);
  }

  function validOutputEntries(value) {
    return Array.isArray(value) && value.length <= 2000 && value.every((entry) => {
      if (!isRecord(entry) || !['blank', 'raw', 'structured'].includes(entry.kind)) {
        return false;
      }
      if (typeof entry.message !== 'string' || entry.message.length > 20000) {
        return false;
      }
      if (entry.kind !== 'structured') {
        return true;
      }
      return (entry.level === undefined
          || (typeof entry.level === 'string'
            && ['log', 'info', 'warning', 'error'].includes(entry.level)))
        && (entry.time === undefined
          || (typeof entry.time === 'string' && entry.time.length <= 100));
    });
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  return {
    WEBVIEW_COMMAND_TYPES,
    WEBVIEW_MESSAGE_TYPES,
    createWebviewCommandRouter,
    createWebviewMessageRouter,
    validateWebviewCommand,
    validateWebviewMessage
  };
}));
