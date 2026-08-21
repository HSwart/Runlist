const { createWebviewCommandRouter } = require('./media/message-router');

function createRunlistWebviewRouter(host, adapters = {}) {
  return createWebviewCommandRouter({
    handlers: {
      approveProjectRepair: () => host.approveProjectRepair(),
      closeScreen: (message) => host.closeScreen(message.draft),
      copyDiagnosisRequest: () => host.copyDiagnosisRequest(),
      copyOutput: () => host.copyProjectOutput(),
      copyPhoneUrl: (message) => host.copyPhoneUrl(message.id, message.url),
      copyProjectPath: (message) => host.copyProjectPath(message.id),
      copyServiceUrl: (message) => host.copyServiceUrl(message.id, Number(message.port)),
      deleteProject: (message) => host.deleteProject(message.id),
      forceCloseProjectPorts: (message) => host.forceCloseProjectPorts(message.id, 'stop'),
      forceCloseProjectPortsAndStart: (message) => host.forceCloseProjectPorts(message.id, 'start'),
      handoffProject: (message) => host.handoffProject(message.id),
      manageRunGroups: (message) => host.showRunGroupManager(message.id),
      openOutputUrl: (message) => host.openOutputUrl(message.url),
      openProject: (message) => host.openProject(message.id),
      openProjectFolder: (message) => host.openProjectFolder(message.id),
      openProjectTerminal: (message) => host.openProjectTerminal(message.id),
      pickFolder: (message) => host.pickFolder(message.draft),
      refreshProjectRepair: () => host.refreshProjectRepair(),
      registerAgent: (message) => host.registerAgent(message.agent),
      rejectProjectRepair: () => host.rejectProjectRepair(),
      resolveServicePort: (message) => host.resolveServicePort(message.id, Number(message.port)),
      restartProject: (message) => host.restartProject(message.id),
      retryProjectRepair: () => host.retryProjectRepair(),
      saveProject: (message) => host.saveProject(message.project),
      setFocusTarget: (message) => {
        host.lastFocusTarget = adapters.validFocusTarget(message.target);
      },
      setSearchQuery: (message) => {
        host.searchQuery = String(message.query || '');
      },
      showAdd: () => host.showAddProject({ type: 'action', action: 'show-add' }),
      showAgentSetup: () => host.showAgentSetup(),
      showDiagnosis: (message) => host.showProjectDiagnosis(message.id),
      showEdit: (message) => host.showEditProject(message.id),
      showOutput: (message) => host.showProjectOutput(message.id),
      startProject: (message) => host.startProject(message.id),
      startRunGroup: (message) => host.startSavedRunGroup(message.id),
      stopAllProjects: () => host.stopAllProjects(),
      stopProject: (message) => host.stopProject(message.id),
      stopRunGroup: (message) => host.stopSavedRunGroup(message.id),
      toggleProjectPin: (message) => host.toggleProjectPin(message.id),
      toggleProjectPreview: (message) => host.toggleProjectPreview(message.id),
      updateDraft: (message) => {
        if (['add', 'edit'].includes(host.mode)) {
          host.draft = adapters.projectFormValues(message.draft);
        }
      },
      useCurrentWorkspace: (message) => host.useCurrentWorkspace(message.draft)
    }
  });
}

module.exports = { createRunlistWebviewRouter };
