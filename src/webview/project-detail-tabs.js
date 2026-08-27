const PROJECT_DETAIL_TABS = Object.freeze({
  overview: 'overview',
  services: 'services',
  requests: 'requests',
  output: 'output',
  preview: 'preview',
  history: 'history'
});

function availableProjectDetailTabs({
  servicesAvailable = false,
  outputAvailable = false,
  previewAvailable = false,
  historyAvailable = false,
  httpInspectorAvailable = false
} = {}) {
  return [
    PROJECT_DETAIL_TABS.overview,
    ...(servicesAvailable ? [PROJECT_DETAIL_TABS.services] : []),
    ...(httpInspectorAvailable ? [PROJECT_DETAIL_TABS.requests] : []),
    ...(outputAvailable ? [PROJECT_DETAIL_TABS.output] : []),
    ...(previewAvailable ? [PROJECT_DETAIL_TABS.preview] : []),
    ...(historyAvailable ? [PROJECT_DETAIL_TABS.history] : [])
  ];
}

function preferredProjectDetailTab(tabs, savedTab) {
  if (tabs.includes(savedTab)) {
    return savedTab;
  }
  return tabs.includes(PROJECT_DETAIL_TABS.preview)
    ? PROJECT_DETAIL_TABS.preview
    : PROJECT_DETAIL_TABS.overview;
}

module.exports = {
  PROJECT_DETAIL_TABS,
  availableProjectDetailTabs,
  preferredProjectDetailTab
};
