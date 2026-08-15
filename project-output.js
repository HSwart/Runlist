const { stripVTControlCharacters } = require('util');

const MAX_PROJECT_OUTPUT_CHARS = 20000;

function appendProjectOutput(current, chunk, limit = MAX_PROJECT_OUTPUT_CHARS) {
  const output = `${current || ''}${String(chunk || '')}`;
  if (output.length <= limit) {
    return output;
  }
  return output.slice(findAnsiSafeStart(output, output.length - limit));
}

function findAnsiSafeStart(output, requestedStart) {
  const escapeStart = output.lastIndexOf('\u001b', requestedStart - 1);
  if (escapeStart < 0 || output[escapeStart + 1] !== '[') {
    return requestedStart;
  }

  const sequence = output.slice(escapeStart).match(/^\u001b\[[0-?]*[ -/]*[@-~]/)?.[0];
  if (!sequence) {
    return escapeStart;
  }

  const escapeEnd = escapeStart + sequence.length;
  return escapeEnd > requestedStart ? escapeEnd : requestedStart;
}

function sanitizeProjectOutput(output) {
  return stripVTControlCharacters(String(output || ''));
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
