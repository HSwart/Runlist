function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeServiceUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) {
    return undefined;
  }
  const safeUrl = safeHttpUrl(input);
  if (!safeUrl) {
    return undefined;
  }
  const url = new URL(safeUrl);
  if (url.username || url.password) {
    return undefined;
  }
  return safeUrl;
}

module.exports = { safeHttpUrl, safeServiceUrl };
