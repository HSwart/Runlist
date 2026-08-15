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
    return output.slice(requestedStart);
  }
  if (sequence.complete) {
    return output.slice(sequence.end);
  }

  return boundIncompleteAnsi(output.slice(sequence.start), limit);
}

function ansiSequenceCrossing(output, boundary) {
  let searchFrom = 0;
  while (searchFrom < boundary) {
    const escapeStart = output.indexOf('\u001b', searchFrom);
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
  const marker = output[escapeStart + 1];
  if (!marker) {
    return { complete: false, end: output.length };
  }

  if (marker === '[') {
    for (let index = escapeStart + 2; index < output.length; index += 1) {
      const code = output.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return { complete: true, end: index + 1 };
      }
      if (code < 0x20 || code > 0x3f) {
        return { complete: true, end: escapeStart + 2 };
      }
    }
    return { complete: false, end: output.length };
  }

  if (']PX^_'.includes(marker)) {
    for (let index = escapeStart + 2; index < output.length; index += 1) {
      if (output.charCodeAt(index) === 0x07) {
        return { complete: true, end: index + 1 };
      }
      if (output[index] === '\u001b' && output[index + 1] === '\\') {
        return { complete: true, end: index + 2 };
      }
    }
    return { complete: false, end: output.length };
  }

  for (let index = escapeStart + 1; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (code >= 0x30 && code <= 0x7e) {
      return { complete: true, end: index + 1 };
    }
    if (code < 0x20 || code > 0x2f) {
      return { complete: true, end: escapeStart + 1 };
    }
  }
  return { complete: false, end: output.length };
}

function boundIncompleteAnsi(sequence, limit) {
  if (limit <= 2) {
    return sequence.slice(0, limit);
  }
  return `${sequence.slice(0, 2)}${sequence.slice(-(limit - 2))}`;
}

function sanitizeProjectOutput(output) {
  const value = stripAnsiStrings(String(output || ''));
  const incompleteStart = findIncompleteAnsiStart(value);
  const completeOutput = incompleteStart >= 0
    ? value.slice(0, incompleteStart)
    : value;
  return stripVTControlCharacters(completeOutput);
}

function stripAnsiStrings(output) {
  let result = '';
  let copyFrom = 0;
  let searchFrom = 0;

  while (searchFrom < output.length) {
    const escapeStart = output.indexOf('\u001b', searchFrom);
    if (escapeStart < 0) {
      break;
    }

    const marker = output[escapeStart + 1];
    if (!']PX^_'.includes(marker || '')) {
      searchFrom = escapeStart + 1;
      continue;
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

function findIncompleteAnsiStart(output) {
  let searchFrom = 0;
  while (searchFrom < output.length) {
    const escapeStart = output.indexOf('\u001b', searchFrom);
    if (escapeStart < 0) {
      return -1;
    }

    const sequence = ansiSequenceAt(output, escapeStart);
    if (!sequence.complete) {
      return escapeStart;
    }
    searchFrom = Math.max(sequence.end, escapeStart + 1);
  }
  return -1;
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
