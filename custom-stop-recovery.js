function customStopFallbackAction({
  commandSucceeded,
  hasConfiguredServices,
  ownershipStopped,
  servicesStopped
}) {
  if (ownershipStopped && servicesStopped) {
    return commandSucceeded || hasConfiguredServices
      ? 'complete'
      : 'report-command-failure';
  }
  if (hasConfiguredServices && !servicesStopped) {
    return 'recover-ports';
  }
  if (!ownershipStopped) {
    return 'stop-owned-process';
  }
  return 'report-command-failure';
}

module.exports = { customStopFallbackAction };
