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

function stopHonestyMessage({
  processActive = false,
  openPorts = [],
  webPort
} = {}) {
  if (processActive) {
    return 'Stop failed';
  }
  const ports = (Array.isArray(openPorts) ? openPorts : [])
    .filter((port) => Number.isInteger(port));
  if (ports.length === 0) {
    return '';
  }
  const port = ports.includes(webPort) ? webPort : ports[0];
  return `Port :${port} is still up`;
}

module.exports = { customStopPostcondition, stopHonestyMessage };
