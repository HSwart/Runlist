const { stripVTControlCharacters } = require('util');

const MAX_PROJECT_OUTPUT_CHARS = 20000;

function appendProjectOutput(current, chunk, limit = MAX_PROJECT_OUTPUT_CHARS) {
  const output = `${current || ''}${String(chunk || '')}`;
  if (limit <= 0) {
    return '';
  }
  if (output.length <= limit) {
    return output;
  }
  return trimProjectOutput(output, limit);
}

function trimProjectOutput(output, limit) {
  const requestedStart = output.length - limit;
  const sequence = ansiSequenceCrossing(output, requestedStart);
  if (!sequence) {
    return sliceFromSafeBoundary(output, requestedStart);
  }
  if (sequence.complete) {
    return sliceFromSafeBoundary(output, sequence.end);
  }

  return boundIncompleteAnsi(output.slice(sequence.start), limit);
}

function ansiSequenceCrossing(output, boundary) {
  let searchFrom = 0;
  while (searchFrom < boundary) {
    const escapeStart = findNextAnsiStart(output, searchFrom, boundary);
    if (escapeStart < 0 || escapeStart >= boundary) {
      return undefined;
    }

    const sequence = ansiSequenceAt(output, escapeStart);
    if (!sequence.complete || sequence.end > boundary) {
      return { ...sequence, start: escapeStart };
    }
    searchFrom = Math.max(sequence.end, escapeStart + 1);
  }
  return undefined;
}

function ansiSequenceAt(output, escapeStart) {
  const startCode = output.charCodeAt(escapeStart);
  if (startCode === 0x9b) {
    return scanCsi(output, escapeStart + 1);
  }

  const stringMarker = ansiStringMarkerAt(output, escapeStart);
  if (stringMarker) {
    const contentStart = startCode === 0x1b ? escapeStart + 2 : escapeStart + 1;
    return scanAnsiString(output, contentStart, stringMarker);
  }

  if (startCode !== 0x1b) {
    return { complete: true, end: escapeStart + 1 };
  }

  const marker = output[escapeStart + 1];
  if (!marker) {
    return { complete: false, end: output.length };
  }

  if (marker === '[') {
    return scanCsi(output, escapeStart + 2);
  }

  for (let index = escapeStart + 1; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (index > escapeStart + 1 && isAnsiStartCode(code)) {
      return { complete: true, end: index };
    }
    if (code >= 0x30 && code <= 0x7e) {
      return { complete: true, end: index + 1 };
    }
    if (code < 0x20 || code > 0x2f) {
      return { complete: true, end: index + 1 };
    }
  }
  return { complete: false, end: output.length };
}

function scanCsi(output, contentStart) {
  for (let index = contentStart; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (isAnsiStartCode(code)) {
      return { complete: true, end: index };
    }
    if (code >= 0x40 && code <= 0x7e) {
      return { complete: true, end: index + 1 };
    }
    if (code < 0x20 || code > 0x3f) {
      return { complete: true, end: index + 1 };
    }
  }
  return { complete: false, end: output.length };
}

function scanAnsiString(output, contentStart, marker) {
  for (let index = contentStart; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (code === 0x18 || code === 0x1a) {
      return { complete: true, end: index + 1 };
    }
    if (marker === ']' && code === 0x07) {
      return { complete: true, end: index + 1 };
    }
    if (code === 0x9c) {
      return { complete: true, end: index + 1 };
    }
    if (output[index] === '\u001b' && output[index + 1] === '\\') {
      return { complete: true, end: index + 2 };
    }
  }
  return { complete: false, end: output.length };
}

function ansiStringMarkerAt(output, start) {
  if (output.charCodeAt(start) === 0x1b) {
    const marker = output[start + 1];
    return ']PX^_'.includes(marker || '') ? marker : '';
  }
  return c1StringMarker(output.charCodeAt(start));
}

function c1StringMarker(code) {
  switch (code) {
    case 0x90: return 'P';
    case 0x98: return 'X';
    case 0x9d: return ']';
    case 0x9e: return '^';
    case 0x9f: return '_';
    default: return '';
  }
}

function isAnsiStartCode(code) {
  return code === 0x1b || code === 0x9b || Boolean(c1StringMarker(code));
}

function findNextAnsiStart(output, searchFrom, stopAt = output.length) {
  for (let index = searchFrom; index < stopAt; index += 1) {
    const code = output.charCodeAt(index);
    if (isAnsiStartCode(code)) {
      return index;
    }
  }
  return -1;
}

function boundIncompleteAnsi(sequence, limit) {
  const prefixLength = sequence.charCodeAt(0) === 0x1b ? 2 : 1;
  if (limit <= prefixLength) {
    return sequence.slice(0, limit);
  }
  const tailLength = limit - prefixLength;
  const tail = sliceFromSafeBoundary(sequence, sequence.length - tailLength);
  return `${sequence.slice(0, prefixLength)}${tail}`;
}

function sliceFromSafeBoundary(value, requestedStart) {
  let start = Math.max(0, requestedStart);
  const code = value.charCodeAt(start);
  const previousCode = value.charCodeAt(start - 1);
  if (code >= 0xdc00 && code <= 0xdfff && previousCode >= 0xd800 && previousCode <= 0xdbff) {
    start += 1;
  }
  return value.slice(start);
}

function sanitizeProjectOutput(output) {
  const value = stripParsedAnsi(String(output || '')).replaceAll('\u009c', '');
  return stripVTControlCharacters(value);
}

function stripParsedAnsi(output) {
  let result = '';
  let copyFrom = 0;
  let searchFrom = 0;

  while (searchFrom < output.length) {
    const escapeStart = findNextAnsiStart(output, searchFrom);
    if (escapeStart < 0) {
      break;
    }

    const sequence = ansiSequenceAt(output, escapeStart);
    result += output.slice(copyFrom, escapeStart);
    if (!sequence.complete) {
      return result;
    }
    copyFrom = sequence.end;
    searchFrom = sequence.end;
  }

  return result + output.slice(copyFrom);
}

function listenToProjectOutput(child, onOutput) {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', onOutput);
  }
}

function formatProjectOutput(output) {
  if (!output) {
    return [];
  }
  return sanitizeProjectOutput(output).split(/\r?\n/).map(formatOutputLine);
}

function createOutputUpdateScheduler(onUpdate, delay = 100) {
  let timer;
  let latestValue;

  return {
    schedule(value) {
      latestValue = value;
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        const valueToSend = latestValue;
        latestValue = undefined;
        onUpdate(valueToSend);
      }, delay);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
      latestValue = undefined;
    }
  };
}

function formatOutputLine(line) {
  if (!line) {
    return { kind: 'blank', message: '' };
  }

  const jsonEntry = parseJsonLogLine(line);
  if (jsonEntry) {
    return jsonEntry;
  }

  const fields = parseLogFields(line);
  const message = fields.msg || fields.message;
  if (message && (fields.level || fields.time || fields.timestamp)) {
    return structuredEntry(message, fields.level, fields.time || fields.timestamp);
  }

  const severityMatch = line.match(/^\s*\[?(error|warn(?:ing)?|info|debug|success)\]?\s*[:\-]?\s+(.+)$/i);
  if (severityMatch) {
    return structuredEntry(severityMatch[2], severityMatch[1]);
  }

  return { kind: 'raw', message: line };
}

function parseJsonLogLine(line) {
  if (!line.trim().startsWith('{')) {
    return undefined;
  }
  try {
    const value = JSON.parse(line);
    const message = value.msg || value.message;
    if (!message) {
      return undefined;
    }
    return structuredEntry(message, value.level, value.time || value.timestamp);
  } catch {
    return undefined;
  }
}

function parseLogFields(line) {
  const fields = {};
  const fieldPattern = /([A-Za-z_][\w.-]*)=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/g;
  for (const match of line.matchAll(fieldPattern)) {
    fields[match[1].toLowerCase()] = unquoteLogValue(match[2]);
  }
  return fields;
}

function unquoteLogValue(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function structuredEntry(message, level, time) {
  return {
    kind: 'structured',
    level: normalizeLevel(level),
    message: String(message),
    time: shortTime(time)
  };
}

function normalizeLevel(level) {
  const normalized = String(level || '').toLowerCase();
  if (normalized === 'warn') {
    return 'warning';
  }
  return ['debug', 'error', 'info', 'success', 'warning'].includes(normalized)
    ? normalized
    : '';
}

function shortTime(value) {
  const match = String(value || '').match(/(?:T|\s)(\d{2}:\d{2}:\d{2})/);
  return match?.[1] || '';
}

module.exports = {
  MAX_PROJECT_OUTPUT_CHARS,
  appendProjectOutput,
  createOutputUpdateScheduler,
  formatProjectOutput,
  listenToProjectOutput,
  sanitizeProjectOutput
};
