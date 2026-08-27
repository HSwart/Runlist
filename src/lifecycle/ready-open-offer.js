function shouldOfferReadyOpen({
  status,
  previewUrl,
  locallyOwned,
  alreadyOpened,
  generation,
  offeredGeneration,
  pending = false
} = {}) {
  if (pending || alreadyOpened || !locallyOwned) {
    return false;
  }
  if (status !== 'running') {
    return false;
  }
  if (typeof previewUrl !== 'string' || !previewUrl) {
    return false;
  }
  if (generation === undefined || generation === null || generation === '') {
    return false;
  }
  if (offeredGeneration === generation) {
    return false;
  }
  return true;
}

function readyOpenMessage(name) {
  return `${String(name || 'Project')} is ready.`;
}

module.exports = {
  readyOpenMessage,
  shouldOfferReadyOpen
};
