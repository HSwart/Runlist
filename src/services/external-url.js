function safeHttpUrl(value) {
  const input = String(value || '');
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return undefined;
  }
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeServiceUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 2048) {
    return undefined;
  }
  return safeHttpUrl(input);
}

module.exports = { safeHttpUrl, safeServiceUrl };
