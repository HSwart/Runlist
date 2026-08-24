function webviewFrameWasReplaced(error) {
  const message = String(error?.message || '');
  return /frame.*detached/i.test(message)
    || /cannot find context with specified id/i.test(message)
    || /execution context was destroyed/i.test(message);
}

module.exports = { webviewFrameWasReplaced };
