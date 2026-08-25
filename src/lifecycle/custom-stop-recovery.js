function customStopPostcondition({
  commandSucceeded,
  hasConfiguredServices,
  hadTrackedOwnership,
  ownershipStopped,
  servicesStopped
}) {
  if (!commandSucceeded) {
    return 'command-failed';
  }
  if (!hasConfiguredServices && !hadTrackedOwnership) {
    return 'unverifiable';
  }
  if (ownershipStopped && servicesStopped) {
    return 'complete';
  }
  return 'partial';
}

module.exports = { customStopPostcondition };
