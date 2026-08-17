const vscode = acquireVsCodeApi();
const state = window.runlistState;
const app = document.getElementById('app');
let searchQuery = String(state.searchQuery || '');
let outputFollowLatest = true;
let previewLoadGeneration = 0;
let previewLoadTimer;
let runningAppNavigatorFrame;
const pendingOutputPeeks = new Map();

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function formatCpuPercent(value) {
  if (!Number.isFinite(value)) {
    return 'Measuring…';
  }
  if (value > 0 && value < 0.1) {
    return '<0.1%';
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function formatMemory(value) {
  if (!Number.isFinite(value)) {
    return 'Unavailable';
  }
  const megabytes = value / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.max(0, Math.round(megabytes))} MB`;
}

function runtimePulsePoints(samples, key) {
  const values = (samples || []).map((sample, index) => ({
    index,
    value: Number(sample?.[key])
  })).filter((sample) => Number.isFinite(sample.value));
  if (values.length < 2) {
    return '';
  }

  const width = 48;
  const height = 12;
  const minimum = Math.min(...values.map((sample) => sample.value));
  const maximum = Math.max(...values.map((sample) => sample.value));
  const range = maximum - minimum;
  const sampleCount = Math.max(2, (samples || []).length);
  return values.map((sample) => {
    const x = (sample.index / (sampleCount - 1)) * width;
    const y = range === 0
      ? height / 2
      : height - (((sample.value - minimum) / range) * (height - 2)) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function runtimePulseSvg(samples, key) {
  const points = runtimePulsePoints(samples, key);
  if (!points) {
    return '';
  }
  return `<svg class="runtime-pulse ${key === 'cpuPercent' ? 'cpu' : 'memory'}" viewBox="0 0 48 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polyline class="runtime-pulse-line" points="${points}" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

function resourceMetricsContent(metrics, runtimePulse = []) {
  if (!metrics?.available) {
    const message = escapeHtml(metrics?.message || 'Resource use is unavailable.');
    return `<span class="resource-unavailable" title="${message}">Resource use unavailable</span>`;
  }
  const cpu = metrics.measuring ? 'Measuring…' : formatCpuPercent(metrics.cpuPercent);
  const memory = metrics.measuring ? 'Measuring…' : formatMemory(metrics.memoryBytes);
  return `<span class="resource-reading"><span><strong>CPU</strong> <span data-resource-cpu>${escapeHtml(cpu)}</span></span>${runtimePulseSvg(runtimePulse, 'cpuPercent')}</span><span class="resource-reading"><span><strong>Memory</strong> <span data-resource-memory>${escapeHtml(memory)}</span></span>${runtimePulseSvg(runtimePulse, 'memoryBytes')}</span>`;
}

function resourceMetricsLabel(metrics) {
  if (!metrics?.available) {
    return metrics?.message || 'Resource use unavailable.';
  }
  const cpu = metrics.measuring ? 'measuring' : formatCpuPercent(metrics.cpuPercent);
  const memory = metrics.measuring ? 'measuring' : formatMemory(metrics.memoryBytes);
  return `Resource use: CPU ${cpu}; memory ${memory}.`;
}

function escapeHtml(value = '') {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function outputUrlCandidate(value) {
  let url = String(value || '').replace(/[.,;!?]+$/g, '');
  const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    while (url.endsWith(close)
      && url.split(close).length > url.split(open).length) {
      url = url.slice(0, -1);
    }
  }
  return url;
}

function outputMessageHtml(value) {
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  let html = '';
  let previousIndex = 0;
  for (const match of String(value || '').matchAll(urlPattern)) {
    html += escapeHtml(String(value).slice(previousIndex, match.index));
    const candidate = outputUrlCandidate(match[0]);
    const url = escapeHtml(candidate);
    html += `<a class="output-url" href="#" data-action="open-output-url" data-url="${url}" title="Open ${url}">${url}</a>`;
    html += escapeHtml(match[0].slice(candidate.length));
    previousIndex = match.index + match[0].length;
  }
  return html + escapeHtml(String(value || '').slice(previousIndex));
}

function outputEntriesHtml(entries, failureSummary) {
  if (!entries?.length) {
    return failureSummary
      ? '<p class="output-empty">No command output was captured.</p>'
      : '<p class="output-empty">No output yet. Start this project to see its output here.</p>';
  }
  return entries.map((entry) => {
    if (entry.kind === 'blank') {
      return '<div class="output-gap" aria-hidden="true"></div>';
    }
    if (entry.kind === 'structured') {
      const level = entry.level || 'log';
      return `
        <div class="output-entry structured ${escapeHtml(level)}">
          ${(entry.time || entry.level) ? `<div class="output-entry-meta">${entry.time ? `<time>${escapeHtml(entry.time)}</time>` : ''}${entry.level ? `<span>${escapeHtml(entry.level)}</span>` : ''}</div>` : ''}
          <div class="output-message">${outputMessageHtml(entry.message)}</div>
        </div>`;
    }
    return `<div class="output-entry raw"><div class="output-message">${outputMessageHtml(entry.message)}</div></div>`;
  }).join('');
}

function outputFailureSummaryHtml(summary) {
  if (!summary?.message) {
    return '';
  }
  return `
    <section class="output-failure-summary" role="status" aria-live="polite">
      <strong>${escapeHtml(summary.title || 'Start failed')}</strong>
      <span>${escapeHtml(summary.message)}</span>
      ${summary.outcome ? `<small>${escapeHtml(summary.outcome)}</small>` : ''}
    </section>`;
}

function icon(name, className = 'icon') {
  // Official VS Code Codicon paths: https://github.com/microsoft/vscode-codicons
  const icons = {
    'chevron-down': { viewBox: '0 0 16 16', body: '<path d="M3.646 5.646a.5.5 0 0 1 .708 0L8 9.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 0-.708Z"/>' },
    close: { viewBox: '0 0 16 16', body: '<path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/>' },
    copy: { viewBox: '0 0 16 16', body: '<path d="M4 4.5C4 3.672 4.672 3 5.5 3h6c.828 0 1.5.672 1.5 1.5v7c0 .828-.672 1.5-1.5 1.5h-6c-.828 0-1.5-.672-1.5-1.5v-7ZM5.5 4a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-6Z"/><path d="M2 3.5C2 2.672 2.672 2 3.5 2H10v1H3.5a.5.5 0 0 0-.5.5V11H2V3.5Z"/>' },
    edit: { viewBox: '0 0 16 16', body: '<path d="M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z"/>' },
    external: { viewBox: '0 0 16 16', body: '<path d="M15 9.5V12.5C15 13.879 13.879 15 12.5 15H3.5C2.121 15 1 13.879 1 12.5V3.5C1 2.121 2.121 1 3.5 1H6.5C6.776 1 7 1.224 7 1.5C7 1.776 6.776 2 6.5 2H3.5C2.673 2 2 2.673 2 3.5V12.5C2 13.327 2.673 14 3.5 14H12.5C13.327 14 14 13.327 14 12.5V9.5C14 9.224 14.224 9 14.5 9C14.776 9 15 9.224 15 9.5ZM14.5 1H9.5C9.224 1 9 1.224 9 1.5C9 1.776 9.224 2 9.5 2H13.293L9.147 6.146C8.952 6.341 8.952 6.658 9.147 6.853C9.245 6.951 9.373 6.999 9.501 6.999C9.629 6.999 9.757 6.95 9.855 6.853L14.001 2.707V6.5C14.001 6.776 14.225 7 14.501 7C14.777 7 15.001 6.776 15.001 6.5V1.5C15.001 1.224 14.777 1 14.501 1H14.5Z"/>' },
    folder: { viewBox: '0 0 16 16', body: '<path d="M2 4.5V6H5.58579C5.71839 6 5.84557 5.94732 5.93934 5.85355L7.29289 4.5L5.93934 3.14645C5.84557 3.05268 5.71839 3 5.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM1 4.5C1 3.11929 2.11929 2 3.5 2H5.58579C5.98361 2 6.36514 2.15804 6.64645 2.43934L8.20711 4H12.5C13.8807 4 15 5.11929 15 6.5V11.5C15 12.8807 13.8807 14 12.5 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5ZM2 7V11.5C2 12.3284 2.67157 13 3.5 13H12.5C13.3284 13 14 12.3284 14 11.5V6.5C14 5.67157 13.3284 5 12.5 5H8.20711L6.64645 6.56066C6.36514 6.84197 5.98361 7 5.58579 7H2Z"/>' },
    loading: { viewBox: '0 0 16 16', body: '<path d="M13.5 8.5C13.224 8.5 13 8.276 13 8C13 5.243 10.757 3 8 3C5.243 3 3 5.243 3 8C3 8.276 2.776 8.5 2.5 8.5C2.224 8.5 2 8.276 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 8.276 13.776 8.5 13.5 8.5Z"/>' },
    more: { viewBox: '0 0 16 16', body: '<path d="M5 8C5 8.55229 4.55228 9 4 9C3.44772 9 3 8.55229 3 8C3 7.44772 3.44772 7 4 7C4.55228 7 5 7.44772 5 8ZM9 8C9 8.55229 8.55229 9 8 9C7.44772 9 7 8.55229 7 8C7 7.44772 7.44772 7 8 7C8.55229 7 9 7.44772 9 8ZM12 9C12.5523 9 13 8.55229 13 8C13 7.44772 12.5523 7 12 7C11.4477 7 11 7.44772 11 8C11 8.55229 11.4477 9 12 9Z"/>' },
    pin: { viewBox: '0 0 16 16', body: '<path d="M14 5v7h-.278c-.406 0-.778-.086-1.117-.258A2.528 2.528 0 0 1 11.73 11H8.87a3.463 3.463 0 0 1-.546.828 3.685 3.685 0 0 1-.735.633c-.27.177-.565.31-.882.398a3.875 3.875 0 0 1-.985.141h-.5V9H2l-1-.5L2 8h3.222V4h.5c.339 0 .664.047.977.14.312.094.607.227.883.4A3.404 3.404 0 0 1 8.87 6h2.859a2.56 2.56 0 0 1 .875-.734c.338-.172.71-.26 1.117-.266H14zm-.778 1.086a1.222 1.222 0 0 0-.32.156 1.491 1.491 0 0 0-.43.461L12.285 7H8.183l-.117-.336a2.457 2.457 0 0 0-.711-1.047C7.027 5.331 6.427 5.09 6 5v7c.427-.088 1.027-.33 1.355-.617.328-.287.565-.636.71-1.047L8.184 10h4.102l.18.297c.057.094.122.177.195.25.073.073.153.143.242.21.088.069.195.12.32.157V6.086z"/>' },
    pinned: { viewBox: '0 0 16 16', body: '<path d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z"/>' },
    play: { viewBox: '0 0 16 16', body: '<path d="M4.74514 3.06414C4.41183 2.87665 4 3.11751 4 3.49993V12.5002C4 12.8826 4.41182 13.1235 4.74512 12.936L12.7454 8.43601C13.0852 8.24486 13.0852 7.75559 12.7454 7.56443L4.74514 3.06414ZM3 3.49993C3 2.35268 4.2355 1.63011 5.23541 2.19257L13.2357 6.69286C14.2551 7.26633 14.2551 8.73415 13.2356 9.30759L5.23537 13.8076C4.23546 14.37 3 13.6474 3 12.5002V3.49993Z"/>' },
    refresh: { viewBox: '0 0 16 16', body: '<path d="M13.6 3.4A6 6 0 1 0 14 11h-1.13A5 5 0 1 1 13 6.17V8h1V3h-5v1h3.88A5.98 5.98 0 0 1 13.6 3.4Z"/>' },
    search: { viewBox: '0 0 16 16', body: '<path d="M10.0195 10.7266C9.06578 11.5217 7.83875 12 6.5 12C3.46243 12 1 9.53757 1 6.5C1 3.46243 3.46243 1 6.5 1C9.53757 1 12 3.46243 12 6.5C12 7.83875 11.5217 9.06578 10.7266 10.0195L13.8535 13.1464C14.0488 13.3417 14.0488 13.6583 13.8535 13.8536C13.6583 14.0488 13.3417 14.0488 13.1464 13.8536L10.0195 10.7266ZM11 6.5C11 4.01472 8.98528 2 6.5 2C4.01472 2 2 4.01472 2 6.5C2 8.98528 4.01472 11 6.5 11C8.98528 11 11 8.98528 11 6.5Z"/>' },
    stop: { viewBox: '0 0 16 16', body: '<path fill-rule="evenodd" clip-rule="evenodd" d="M5.5 5C5.22386 5 5 5.22386 5 5.5V10.5C5 10.7761 5.22386 11 5.5 11H10.5C10.7761 11 11 10.7761 11 10.5V5.5C11 5.22386 10.7761 5 10.5 5H5.5ZM4 5.5C4 4.67157 4.67157 4 5.5 4H10.5C11.3284 4 12 4.67157 12 5.5V10.5C12 11.3284 11.3284 12 10.5 12H5.5C4.67157 12 4 11.3284 4 10.5V5.5Z"/>' },
    terminal: { viewBox: '0 0 24 24', body: '<path d="M18.75 1.5H5.25C3.1815 1.5 1.5 3.183 1.5 5.25V18.75C1.5 20.8185 3.1815 22.5 5.25 22.5H18.75C20.8185 22.5 22.5 20.8185 22.5 18.75V5.25C22.5 3.183 20.8185 1.5 18.75 1.5ZM21 18.75C21 19.9905 19.9905 21 18.75 21H5.25C4.0095 21 3 19.9905 3 18.75V5.25C3 4.0095 4.0095 3 5.25 3H18.75C19.9905 3 21 4.0095 21 5.25V18.75ZM10.281 13.281L5.781 17.781C5.634 17.928 5.442 18 5.25 18C5.058 18 4.866 17.9265 4.719 17.781C4.4265 17.4885 4.4265 17.013 4.719 16.7205L8.688 12.7515L4.719 8.7825C4.4265 8.49 4.4265 8.0145 4.719 7.722C5.0115 7.4295 5.487 7.4295 5.7795 7.722L10.2795 12.222C10.572 12.5145 10.572 12.99 10.2795 13.2825L10.281 13.281ZM19.5 17.25C19.5 17.664 19.164 18 18.75 18H11.25C10.836 18 10.5 17.664 10.5 17.25C10.5 16.836 10.836 16.5 11.25 16.5H18.75C19.164 16.5 19.5 16.836 19.5 17.25Z"/>' },
    trash: { viewBox: '0 0 16 16', body: '<path d="M14 2H10C10 0.897 9.103 0 8 0C6.897 0 6 0.897 6 2H2C1.724 2 1.5 2.224 1.5 2.5C1.5 2.776 1.724 3 2 3H2.54L3.349 12.708C3.456 13.994 4.55 15 5.84 15H10.159C11.449 15 12.543 13.993 12.65 12.708L13.459 3H13.999C14.275 3 14.499 2.776 14.499 2.5C14.499 2.224 14.275 2 13.999 2H14ZM8 1C8.551 1 9 1.449 9 2H7C7 1.449 7.449 1 8 1ZM11.655 12.625C11.591 13.396 10.934 14 10.16 14H5.841C5.067 14 4.41 13.396 4.346 12.625L3.544 3H12.458L11.656 12.625H11.655ZM7 5.5V11.5C7 11.776 6.776 12 6.5 12C6.224 12 6 11.776 6 11.5V5.5C6 5.224 6.224 5 6.5 5C6.776 5 7 5.224 7 5.5ZM10 5.5V11.5C10 11.776 9.776 12 9.5 12C9.224 12 9 11.776 9 11.5V5.5C9 5.224 9.224 5 9.5 5C9.776 5 10 5.224 10 5.5Z"/>' }
  };
  const selected = icons[name];
  return `<svg class="${className}" viewBox="${selected.viewBox}" fill="currentColor" aria-hidden="true" focusable="false">${selected.body}</svg>`;
}

function productIcon(name, className = 'product-icon') {
  return icon(name, className);
}

function readinessServiceList(services) {
  return (services || [])
    .map((service) => `${escapeHtml(String(service.name))} <strong>:${escapeHtml(String(service.port))}</strong>`)
    .join(', ');
}

function readinessDetailsHtml(project, status) {
  if (!['not-ready', 'not-responding'].includes(status)) {
    return '';
  }

  const details = project.serviceReadiness || {};
  const rows = [];
  if (details.ready?.length) {
    rows.push(`<span><strong>Ready:</strong> ${readinessServiceList(details.ready)}</span>`);
  }
  if (details.waiting?.length) {
    rows.push(`<span><strong>Still checking:</strong> ${readinessServiceList(details.waiting)}</span>`);
  }
  if (details.notResponding?.length) {
    rows.push(`<span><strong>Waiting for web response:</strong> ${readinessServiceList(details.notResponding)}</span>`);
  }
  return rows.length ? `<div class="project-readiness-detail">${rows.join('')}</div>` : '';
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatStartupDuration(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.max(0, Math.round(milliseconds))}ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function startupHistoryHtml(project, projectName) {
  const history = project.startupHistory || [];
  if (!history.length || !project.detailsExpanded) {
    return '';
  }
  const labels = {
    ready: { code: 'OK', label: 'Ready' },
    failed: { code: 'FAIL', label: 'Failed' },
    'timed-out': { code: 'SLOW', label: 'Still starting' }
  };
  const readyCount = history.filter((entry) => entry.outcome === 'ready').length;
  const summary = `Recent starts for ${project.name}, oldest to newest: ${history.map((entry) => {
    const outcome = labels[entry.outcome] || labels.failed;
    return `${outcome.label} after ${formatStartupDuration(entry.durationMs)}`;
  }).join('; ')}.`;
  return `
    <section class="startup-history" role="group" aria-label="${escapeHtml(summary)}">
      <header><strong>Recent starts</strong><span>${readyCount} of ${history.length} ready</span></header>
      <div class="startup-history-ribbon" style="--startup-count: ${history.length}" aria-hidden="true">
        ${history.map((entry) => {
          const outcome = labels[entry.outcome] || labels.failed;
          const duration = formatStartupDuration(entry.durationMs);
          return `<span class="startup-history-entry ${escapeHtml(entry.outcome)}" title="${outcome.label} after ${escapeHtml(duration)}"><strong>${outcome.code}</strong><span>${escapeHtml(duration)}</span></span>`;
        }).join('')}
      </div>
    </section>`;
}

function timelineElapsedLabel(timeline) {
  if (!Number.isFinite(timeline?.launchedAt)) {
    return timeline?.failed ? 'Start did not complete.' : 'Waiting to start…';
  }
  if (Number.isFinite(timeline.readyAt)) {
    return `Ready in ${formatElapsed(timeline.readyAt - timeline.launchedAt)}`;
  }
  return `Elapsed ${formatElapsed(Date.now() - timeline.launchedAt)}`;
}

function projectTimelineHtml(project, projectName) {
  const timeline = project.timeline;
  if (!timeline || !project.timelineExpanded) {
    return '';
  }
  const stages = (timeline.stages || []).map((stage) => `
    <li class="timeline-stage timeline-${escapeHtml(stage.state)}">
      <span class="timeline-marker" aria-hidden="true"></span>
      <span>${escapeHtml(stage.label)}</span>
    </li>`).join('');
  const outputLink = (timeline.failed || timeline.attention) && timeline.outputAvailable
    ? `<button class="timeline-output-link" data-action="output" data-id="${escapeHtml(project.id)}">View Recent Output</button>`
    : '';
  return `
    <div class="project-timeline" aria-label="Startup timeline for ${projectName}">
      <ol class="timeline-stages">${stages}</ol>
      <p class="timeline-elapsed" data-timeline-elapsed data-started-at="${timeline.launchedAt || ''}" data-ready-at="${timeline.readyAt || ''}">${escapeHtml(timelineElapsedLabel(timeline))}</p>
      ${(timeline.failed || timeline.attention) && !timeline.outputAvailable ? '<p class="timeline-output-note">Recent output is available in the VS Code window that started this project.</p>' : ''}
      ${outputLink}
    </div>`;
}

function outputPeekEntriesHtml(entries) {
  return (entries || []).map((entry) => {
    const level = entry.kind === 'structured' ? entry.level || 'log' : 'log';
    const meta = entry.kind === 'structured' && (entry.time || entry.level)
      ? `<span class="output-peek-meta">${entry.time ? `<time>${escapeHtml(entry.time)}</time>` : ''}${entry.level ? `<span>${escapeHtml(entry.level)}</span>` : ''}</span>`
      : '';
    return `<li class="output-peek-line ${escapeHtml(level)}">${meta}<span class="output-peek-message">${escapeHtml(entry.message)}</span></li>`;
  }).join('');
}

function projectOutputPeekHtml(entries, projectId, projectName) {
  if (!entries?.length) {
    return '';
  }
  const safeProjectId = escapeHtml(String(projectId || ''));
  const safeProjectName = escapeHtml(String(projectName || 'project'));
  return `
    <section class="project-output-peek" tabindex="0" aria-label="Latest output for ${safeProjectName}">
      <header><span>Live output</span><button data-action="output" data-id="${safeProjectId}">View output</button></header>
      <ol>${outputPeekEntriesHtml(entries)}</ol>
    </section>`;
}

function statusSummaryHtml(projects) {
  const reviewCount = projects.filter((project) => project.reviewRequired).length;
  const runningCount = projects
    .filter((project) => !project.reviewRequired
      && (project.status === 'running'
        || (project.status === 'active' && !project.httpUnresponsive))).length;
  const startingCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'starting').length;
  const notReadyCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'not-ready').length;
  const notRespondingCount = projects
    .filter((project) => !project.reviewRequired
      && (project.status === 'not-responding'
        || (project.status === 'active' && project.httpUnresponsive))).length;
  const stoppingCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'stopping').length;
  const stoppedCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'stopped').length;
  const conflictCount = projects
    .filter((project) => !project.reviewRequired
      && ['port-in-use', 'port-in-use-unknown'].includes(project.status)).length;
  return `<span class="status-dot ${runningCount ? 'running' : ''}"></span>${runningCount} running${startingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${startingCount} starting` : ''}${notReadyCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${notReadyCount} taking longer` : ''}${notRespondingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${notRespondingCount} not responding` : ''}${stoppingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${stoppingCount} stopping` : ''} <span class="summary-separator" aria-hidden="true">·</span> ${stoppedCount} stopped${reviewCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${reviewCount} to review` : ''}${conflictCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${conflictCount} unavailable` : ''}`;
}

function renderList() {
  if (state.projects.length === 0) {
    app.innerHTML = `
      <section class="empty-state">
        ${icon('folder', 'empty-icon')}
        <h2>No projects yet</h2>
        <p>Save a project folder and its commands once, then start it from here.</p>
        <button class="primary-button" data-action="show-add">Add project</button>
      </section>`;
    return;
  }

  const runningAppIds = new Set((state.runningAppIds || []).map(String));
  const runningApps = state.projects.filter((project) => runningAppIds.has(String(project.id)));

  app.innerHTML = `
    <header class="summary" aria-label="Project status summary">
      <span id="project-count"><strong>${state.projects.length}</strong> ${state.projects.length === 1 ? 'project' : 'projects'}</span>
      <span id="summary-status" class="summary-status">${statusSummaryHtml(state.projects)}</span>
    </header>
    ${state.stopAllCount > 1 ? `
      <div class="bulk-actions">
        <button class="stop-all-button" data-action="stop-all" aria-label="Stop all ${state.stopAllCount} running projects">
          ${productIcon('stop', 'bulk-stop-icon')}
          Stop all running (${state.stopAllCount})
        </button>
      </div>` : ''}
    <div class="project-search">
      ${icon('search', 'search-icon')}
      <input id="project-search" type="search" value="${escapeHtml(searchQuery)}" placeholder="Search projects" aria-label="Search projects" autocomplete="off" spellcheck="false">
    </div>
    <span id="project-search-status" class="visually-hidden" aria-live="polite"></span>
    ${runningApps.length > 1 ? `
      <nav class="running-app-navigator" data-running-app-navigator aria-label="Running app navigator" hidden>
        <div class="running-app-bar">
          <span class="status-dot running" aria-hidden="true"></span>
          <button class="running-app-current" data-action="show-running-app" aria-label="Show running app">
            <span class="auto-scroll"><span class="auto-scroll-content" data-running-app-name></span></span>
          </button>
          <span class="running-app-position" data-running-app-position aria-hidden="true"></span>
          <div class="running-app-navigation">
            <button class="running-app-previous" data-action="previous-running-app" aria-label="Previous running app" title="Previous running app">${icon('chevron-down')}</button>
            <button data-action="next-running-app" aria-label="Next running app" title="Next running app">${icon('chevron-down')}</button>
          </div>
        </div>
        <div class="running-app-thumbnail" data-running-app-thumbnail>
          <iframe data-running-app-frame title="Running app preview" aria-hidden="true" tabindex="-1" sandbox="allow-forms allow-scripts allow-same-origin" referrerpolicy="no-referrer" loading="lazy"></iframe>
          <button class="running-app-thumbnail-target" data-action="show-running-app" aria-label="Show running app" title="Double-click to open in browser"></button>
          <span class="running-app-thumbnail-unavailable" data-running-app-thumbnail-unavailable hidden>No web preview</span>
          <button class="running-app-open" data-action="open" aria-label="Open running app in browser" title="Open in browser">${icon('external')}</button>
        </div>
      </nav>` : ''}
    <section class="project-list" aria-label="Projects">
      ${state.projects.map((project) => {
        const projectId = escapeHtml(project.id);
        const projectName = escapeHtml(project.name);
        const projectStatus = project.status || 'stopped';
        const reviewRequired = Boolean(project.reviewRequired);
        const displayStatus = reviewRequired ? 'review-required' : projectStatus;
        const statusClass = projectStatus === 'active' && project.httpUnresponsive
          ? 'not-responding'
          : displayStatus;
        const conflict = project.portConflict;
        const conflictOwnerName = escapeHtml(conflict?.ownerName || 'Another app');
        const conflictProjectNames = (conflict?.projectNames || []).map(escapeHtml).join(', ');
        const statusLabels = {
          running: 'Running',
          starting: 'Starting…',
          'not-ready': 'Taking longer…',
          'not-responding': 'Web service not responding',
          stopping: 'Stopping…',
          active: project.httpUnresponsive ? 'Detected, web service not responding' : 'Detected running',
          'port-in-use': conflict?.ownerName ? `Port in use by ${conflictOwnerName}` : 'Port in use',
          'port-in-use-unknown': 'Port in use — owner unknown',
          'review-required': 'Review setup',
          stopped: 'Stopped'
        };
        const conflicted = ['port-in-use', 'port-in-use-unknown'].includes(projectStatus);
        const canHandoff = projectStatus === 'port-in-use'
          && conflict?.handoffAvailable
          && conflict?.ownerName;
        const handoffLabel = `Stop ${conflictOwnerName} and start ${projectName}`;
        const transitioning = ['starting', 'not-ready', 'stopping'].includes(projectStatus);
        const canOpen = Boolean(project.previewUrl);
        const detectedWithoutStop = projectStatus === 'active' && !project.stopCommand;
        const stopState = ['running', 'starting', 'not-ready', 'not-responding', 'active'].includes(projectStatus);
        const canRestart = !reviewRequired
          && ['running', 'not-ready', 'not-responding', 'active'].includes(projectStatus)
          && !detectedWithoutStop;
        const stopsProject = stopState && !detectedWithoutStop;
        const blocked = conflicted;
        const action = reviewRequired ? 'edit' : stopState ? 'stop' : 'start';
        const actionLabel = reviewRequired
          ? 'Review setup'
          : detectedWithoutStop
          ? 'Stop unavailable'
          : blocked
          ? 'Unavailable'
          : projectStatus === 'stopping'
          ? 'Stopping…'
          : stopsProject
            ? 'Stop'
            : 'Start';
        const actionTitle = reviewRequired
          ? `Review setup for ${projectName}`
          : detectedWithoutStop
          ? `Runlist did not start ${projectName}. Add a custom stop command to stop it safely.`
          : projectStatus === 'port-in-use-unknown'
          ? `Port :${conflict?.port || 'unknown'} owner is unknown — cannot safely start or stop ${projectName}`
          : blocked
            ? `${conflictOwnerName} is using port :${conflict?.port || 'unknown'} — cannot start ${projectName}`
          : `${actionLabel} ${projectName}`;
        const openTitle = canOpen
          ? `Open ${projectName} in your browser`
          : conflicted
            ? 'This port may belong to another app'
            : stopState
              ? `${projectName} does not have a responding web service yet`
              : `Start ${projectName} before opening it`;
        const statusTitle = reviewRequired
          ? 'A coding agent added or updated this setup. Review its folder and commands before running it.'
          : projectStatus === 'active'
          ? project.httpUnresponsive
            ? 'The configured port is open, but the web service did not respond. Runlist did not start this process.'
            : 'Detected through a configured service port; Runlist did not start this process.'
          : projectStatus === 'not-responding'
            ? 'The launched process is still running and its configured port is open, but the web service did not respond.'
          : projectStatus === 'not-ready'
            ? 'The launched process is still running. Runlist is continuing to check its configured services.'
          : projectStatus === 'port-in-use-unknown'
            ? `Port :${conflict?.port || 'unknown'} is shared with ${conflictProjectNames}. Runlist cannot identify the running owner.`
            : projectStatus === 'port-in-use'
              ? `${conflictOwnerName} is using port :${conflict?.port || 'unknown'}.`
              : '';
        const actionDisabled = projectStatus === 'stopping' || blocked || detectedWithoutStop;
        return `
          <article id="project-row-${projectId}" class="project-row" data-project-id="${projectId}" aria-labelledby="project-${projectId}" tabindex="-1">
            <div class="project-topline">
              <div class="project-heading">
                <div class="project-title-line">
                  <h2 id="project-${projectId}" title="${project.pinned ? `Pinned: ${projectName}` : projectName}" aria-label="${project.pinned ? `Pinned project: ${projectName}` : projectName}">
                    ${project.pinned ? icon('pinned', 'pinned-icon') : ''}
                    <span class="auto-scroll"><span class="auto-scroll-content">${projectName}</span></span>
                  </h2>
                </div>
                <div class="project-status status-${statusClass}"${statusTitle ? ` title="${statusTitle}"` : ''}>${!reviewRequired && transitioning ? productIcon('loading', 'status-progress') : ''}<span class="auto-scroll"><span class="auto-scroll-content">${statusLabels[displayStatus]}</span></span></div>
                ${!reviewRequired ? readinessDetailsHtml(project, projectStatus) : ''}
              </div>
              <div class="project-actions">
                <button class="run-button ${reviewRequired ? 'review' : blocked ? 'blocked' : stopState || projectStatus === 'stopping' ? 'stop' : 'start'}" data-action="${action}" data-id="${projectId}" aria-label="${actionTitle}" title="${actionTitle}" ${actionDisabled && !reviewRequired ? 'disabled' : ''}>
                  ${reviewRequired ? icon('edit') : productIcon(stopState || projectStatus === 'stopping' ? 'stop' : 'play')}
                </button>
                <button class="more-button" data-action="toggle-menu" data-id="${projectId}" aria-label="More actions for ${projectName}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
                <div class="action-menu" data-menu-id="${projectId}" role="menu" aria-label="Actions for ${projectName}" hidden>
                  <button data-action="open" data-id="${projectId}" role="menuitem" ${canOpen ? '' : 'disabled'} title="${openTitle}">
                    ${icon('external', 'menu-icon')}<span>Open app</span>
                  </button>
                  <button data-action="open-vscode" data-id="${projectId}" role="menuitem" title="Open ${projectName} in a new VS Code window">
                    ${icon('folder', 'menu-icon')}<span>Open in VS Code</span>
                  </button>
                  <button data-action="open-terminal" data-id="${projectId}" role="menuitem" title="Open a terminal in ${projectName}">
                    ${icon('terminal', 'menu-icon')}<span>Open terminal here</span>
                  </button>
                  <button data-action="copy-project-path" data-id="${projectId}" role="menuitem" title="Copy the saved folder path for ${projectName}">
                    ${icon('copy', 'menu-icon')}<span>Copy project path</span>
                  </button>
                  <button data-action="output" data-id="${projectId}" role="menuitem">
                    ${icon('terminal', 'menu-icon')}<span>View output</span>
                  </button>
                  <button data-action="restart" data-id="${projectId}" role="menuitem" aria-label="Restart ${projectName}" ${canRestart ? '' : 'disabled'}>
                    ${icon('refresh', 'menu-icon')}<span>Restart</span>
                  </button>
                  <button data-action="edit" data-id="${projectId}" role="menuitem">
                    ${icon('edit', 'menu-icon')}<span>${reviewRequired ? 'Review setup' : 'Edit project'}</span>
                  </button>
                  <button data-action="toggle-pin" data-id="${projectId}" role="menuitem" aria-label="${project.pinned ? `Unpin ${projectName}` : `Pin ${projectName} to the top`}">
                    ${icon(project.pinned ? 'pinned' : 'pin', 'menu-icon')}<span>${project.pinned ? 'Unpin' : 'Pin to top'}</span>
                  </button>
                  <div class="menu-divider" role="separator"></div>
                  <button class="danger" data-action="delete" data-id="${projectId}" role="menuitem">
                    ${icon('trash', 'menu-icon')}<span>Delete project</span>
                  </button>
                </div>
              </div>
            </div>
            ${canHandoff ? `<button class="handoff-button" data-action="handoff" data-id="${projectId}" aria-label="${handoffLabel}" title="${handoffLabel}" ${project.handoffInProgress ? 'disabled' : ''}>
              ${project.handoffInProgress ? productIcon('loading', 'status-progress') : productIcon('play')}
              <span>${project.handoffInProgress ? `Stopping ${conflictOwnerName}, then starting ${projectName}…` : handoffLabel}</span>
            </button>` : ''}
            <div class="project-details">
              <div class="detail-row" title="${escapeHtml(project.folder)}">
                ${icon('folder', 'detail-icon')}<span class="auto-scroll"><span class="auto-scroll-content">${escapeHtml(project.folder)}</span></span>
              </div>
            </div>
            ${project.services?.length ? `
              <div class="project-services-row">
                <div class="project-services" aria-label="Service ports">
                  ${project.services.map((service) => {
                  const portOpen = project.openPorts?.includes(service.port);
                  const canCopyUrl = project.serviceUrls?.some((entry) => entry.port === service.port)
                    && !reviewRequired
                    && !conflicted;
                  const webNotResponding = !conflicted
                    && portOpen
                    && project.webPorts?.includes(service.port)
                    && !project.respondingPorts?.includes(service.port);
                  const indicator = conflicted
                    ? 'conflict'
                    : webNotResponding
                      ? 'not-responding'
                      : portOpen
                        ? 'running'
                        : '';
                  const title = webNotResponding
                    ? ` title="${escapeHtml(service.name)} port is open, but its web service is not responding"`
                    : '';
                  const ariaLabel = webNotResponding
                    ? ` aria-label="${escapeHtml(service.name)} on port ${escapeHtml(String(service.port))}: web service not responding"`
                    : '';
                  const copyLabel = `Copy ${escapeHtml(service.name)} URL`;
                  return `<span${title}${ariaLabel}><span class="service-indicator ${indicator}" aria-hidden="true"></span>${escapeHtml(service.name)} <strong>:${escapeHtml(String(service.port))}</strong>${canCopyUrl ? `<button class="copy-url-button" data-action="copy-service-url" data-id="${projectId}" data-port="${escapeHtml(String(service.port))}" aria-label="${copyLabel}" title="${copyLabel}">${icon('copy')}</button>` : ''}</span>`;
                  }).join('')}
                </div>
                ${(project.timeline || project.previewUrl || project.startupHistory?.length) ? `<button class="preview-toggle" data-action="toggle-preview" data-id="${projectId}" aria-label="${project.detailsExpanded ? 'Collapse' : 'Expand'} ${project.timeline || project.startupHistory?.length ? 'project details' : 'preview'} for ${projectName}" aria-expanded="${project.detailsExpanded}" aria-controls="details-${projectId}" title="${project.detailsExpanded ? 'Collapse' : 'Expand'} ${project.timeline || project.startupHistory?.length ? 'project details' : 'app preview'}">${icon('chevron-down')}</button>` : ''}
              </div>` : ''}
            ${!project.services?.length && project.startupHistory?.length ? `
              <div class="project-details-toggle-row">
                <button class="preview-toggle" data-action="toggle-preview" data-id="${projectId}" aria-label="${project.detailsExpanded ? 'Collapse' : 'Expand'} project details for ${projectName}" aria-expanded="${project.detailsExpanded}" aria-controls="details-${projectId}" title="${project.detailsExpanded ? 'Collapse' : 'Expand'} project details">${icon('chevron-down')}</button>
              </div>` : ''}
            ${(project.timeline || project.previewUrl || project.startupHistory?.length) ? `<div id="details-${projectId}" class="project-live-details" ${project.detailsExpanded ? '' : 'hidden'}>
            ${startupHistoryHtml(project, projectName)}
            ${project.timeline ? projectTimelineHtml(project, projectName) : ''}
            ${project.outputPeek !== undefined ? `<div class="project-output-peek-slot" data-output-peek-slot data-project-id="${projectId}" data-project-name="${projectName}">${projectOutputPeekHtml(project.outputPeek, project.id, project.name)}</div>` : ''}
            ${project.previewUrl ? `
              <section class="project-preview" aria-label="Preview of ${projectName}" ${project.previewExpanded ? '' : 'hidden'}>
                ${project.previewExpanded ? `
                <header class="preview-toolbar">
                  <span>Preview</span>
                  <div class="preview-actions">
                    <button data-action="refresh-preview" data-id="${projectId}" aria-label="Refresh ${projectName} preview" title="Refresh preview">${icon('refresh')}</button>
                    <button data-action="copy-service-url" data-id="${projectId}" data-port="${escapeHtml(String(project.previewPort))}" aria-label="Copy ${projectName} URL" title="Copy URL">${icon('copy')}</button>
                    <button data-action="open" data-id="${projectId}" aria-label="Open ${projectName} in browser" title="Open in browser">${icon('external')}</button>
                  </div>
                </header>
                <div class="resource-metrics" data-resource-metrics data-project-id="${projectId}" role="group" aria-label="${escapeHtml(resourceMetricsLabel(project.resourceMetrics))}">
                  ${resourceMetricsContent(project.resourceMetrics, project.runtimePulse)}
                </div>
                <div class="preview-frame-wrap">
                  <iframe class="preview-frame" data-preview-frame data-src="${escapeHtml(project.previewUrl)}" title="${projectName} app preview" sandbox="allow-forms allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
                  <div class="preview-loading" data-preview-loading role="status">Loading preview…</div>
                  <div class="preview-fallback" data-preview-fallback hidden>
                    <strong>Preview unavailable</strong>
                    <span>This app may block embedded views.</span>
                  </div>
                </div>
                <p class="preview-help">If the app blocks this view, use Open in browser.</p>
                ` : ''}
              </section>` : ''}
            </div>` : ''}
          </article>`;
      }).join('')}
      <div class="search-empty" data-search-empty hidden>
        <h2>No matching projects</h2>
        <p>Try a different name or folder.</p>
      </div>
    </section>`;

  applyProjectFilter(searchQuery);
}

function applyProjectFilter(query) {
  searchQuery = query;
  const normalizedQuery = normalizeSearchQuery(query);
  const matchingProjects = state.projects.filter((project) => {
    if (!normalizedQuery) {
      return true;
    }

    const searchableText = String(
      project.searchText || [project.name, project.folder].filter(Boolean).join('\n')
    ).toLocaleLowerCase();
    return searchableText.includes(normalizedQuery);
  });
  const matchingIds = new Set(matchingProjects.map((project) => String(project.id)));

  document.querySelectorAll('.project-row').forEach((row) => {
    row.hidden = !matchingIds.has(row.dataset.projectId);
  });

  const searching = normalizedQuery.length > 0;
  const projectCount = document.getElementById('project-count');
  if (projectCount) {
    projectCount.innerHTML = searching
      ? `<strong>${matchingIds.size}</strong> of ${state.projects.length} projects`
      : `<strong>${state.projects.length}</strong> ${state.projects.length === 1 ? 'project' : 'projects'}`;
  }

  const summaryStatus = document.getElementById('summary-status');
  if (summaryStatus) {
    summaryStatus.innerHTML = statusSummaryHtml(matchingProjects);
  }

  const emptyState = document.querySelector('[data-search-empty]');
  if (emptyState) {
    emptyState.hidden = !searching || matchingIds.size > 0;
  }

  const status = document.getElementById('project-search-status');
  if (status) {
    status.textContent = searching
      ? `${matchingIds.size} ${matchingIds.size === 1 ? 'project' : 'projects'} found`
      : '';
  }
  scheduleAutoScrollUpdate();
}

function revealRunningApp(id) {
  const project = state.projects.find((entry) => String(entry.id) === String(id));
  const row = document.querySelector(`.project-row[data-project-id="${CSS.escape(String(id || ''))}"]`);
  if (!project || !row) {
    return;
  }

  if (row.hidden) {
    const search = document.getElementById('project-search');
    if (search) {
      search.value = '';
    }
    vscode.postMessage({ type: 'setSearchQuery', query: '' });
    applyProjectFilter('');
  }

  row.scrollIntoView({ block: 'nearest' });
  row.focus({ preventScroll: true });
  scheduleRunningAppNavigatorUpdate();
}

function runningAppRows() {
  return (state.runningAppIds || []).map((id) => {
    const project = state.projects.find((entry) => String(entry.id) === String(id));
    const row = document.querySelector(`.project-row[data-project-id="${CSS.escape(String(id))}"]`);
    return project && row ? { project, row } : undefined;
  }).filter(Boolean);
}

function updateRunningAppNavigator() {
  const navigator = document.querySelector('[data-running-app-navigator]');
  const entries = runningAppRows();
  if (!navigator || entries.length < 2) {
    return;
  }

  const navigatorBounds = navigator.getBoundingClientRect();
  const navigatorOffset = !navigator.hidden && navigatorBounds.top <= 0
    ? navigator.offsetHeight
    : 0;
  const allFit = entries.every(({ row }) => {
    if (row.hidden) {
      return false;
    }
    const bounds = row.getBoundingClientRect();
    return bounds.top - navigatorOffset >= 0
      && bounds.bottom - navigatorOffset <= window.innerHeight;
  });
  navigator.hidden = allFit;
  if (allFit) {
    unloadRunningAppThumbnail(navigator);
    return;
  }

  const visibleEntries = entries.filter(({ row }) => !row.hidden);
  const candidates = visibleEntries.length ? visibleEntries : entries;
  const viewportMiddle = window.innerHeight / 2;
  const current = candidates.reduce((closest, entry) => {
    const bounds = entry.row.getBoundingClientRect();
    const distance = Math.abs((bounds.top + bounds.bottom) / 2 - viewportMiddle);
    return !closest || distance < closest.distance ? { entry, distance } : closest;
  }, undefined)?.entry || entries[0];
  const currentIndex = entries.indexOf(current);
  const name = navigator.querySelector('[data-running-app-name]');
  const position = navigator.querySelector('[data-running-app-position]');
  const currentButton = navigator.querySelector('[data-action="show-running-app"]');
  const thumbnailTarget = navigator.querySelector('.running-app-thumbnail-target');
  const openButton = navigator.querySelector('.running-app-open');
  const currentChanged = currentButton?.dataset.id !== String(current.project.id);
  if (name) {
    name.textContent = current.project.name;
  }
  if (position) {
    position.textContent = `${currentIndex + 1} of ${entries.length}`;
  }
  if (currentButton) {
    currentButton.dataset.id = current.project.id;
    currentButton.setAttribute('aria-label', `Show ${current.project.name}, running app ${currentIndex + 1} of ${entries.length}`);
    currentButton.title = `Show ${current.project.name}`;
  }
  if (thumbnailTarget) {
    thumbnailTarget.dataset.id = current.project.id;
    thumbnailTarget.dataset.canOpen = String(Boolean(current.project.previewUrl));
    thumbnailTarget.setAttribute(
      'aria-label',
      current.project.previewUrl
        ? `Show ${current.project.name}; double-click to open in browser`
        : `Show ${current.project.name}`
    );
    thumbnailTarget.title = current.project.previewUrl
      ? 'Double-click to open in browser'
      : `Show ${current.project.name}`;
  }
  if (openButton) {
    openButton.dataset.id = current.project.id;
    openButton.hidden = !current.project.previewUrl;
    openButton.setAttribute('aria-label', `Open ${current.project.name} in browser`);
  }
  updateRunningAppThumbnail(navigator, current.project);
  if (currentChanged) {
    scheduleAutoScrollUpdate();
  }
}

function unloadRunningAppThumbnail(navigator) {
  const frame = navigator?.querySelector('[data-running-app-frame]');
  if (frame) {
    frame.removeAttribute('src');
    delete frame.dataset.url;
    frame.title = 'Running app preview';
  }
}

function updateRunningAppThumbnail(navigator, project) {
  const frame = navigator.querySelector('[data-running-app-frame]');
  const unavailable = navigator.querySelector('[data-running-app-thumbnail-unavailable]');
  const url = project.previewUrl;
  if (!frame || !unavailable) {
    return;
  }
  unavailable.hidden = Boolean(url);
  frame.hidden = !url;
  if (!url) {
    unloadRunningAppThumbnail(navigator);
    return;
  }
  frame.title = `${project.name} live thumbnail`;
  if (frame.dataset.url !== url) {
    frame.dataset.url = url;
    frame.src = url;
  }
}

function scheduleRunningAppNavigatorUpdate() {
  cancelAnimationFrame(runningAppNavigatorFrame);
  runningAppNavigatorFrame = requestAnimationFrame(updateRunningAppNavigator);
}

function navigateRunningApps(direction) {
  const navigator = document.querySelector('[data-running-app-navigator]');
  const entries = runningAppRows();
  if (!navigator || entries.length < 2) {
    return;
  }
  const currentId = navigator.querySelector('[data-action="show-running-app"]')?.dataset.id;
  const currentIndex = Math.max(0, entries.findIndex(({ project }) => String(project.id) === currentId));
  const nextIndex = (currentIndex + direction + entries.length) % entries.length;
  revealRunningApp(entries[nextIndex].project.id);
}

function updateAutoScroll() {
  document.querySelectorAll('.auto-scroll').forEach((container) => {
    const content = container.querySelector('.auto-scroll-content');
    container.classList.remove('is-overflowing');
    container.style.removeProperty('--auto-scroll-distance');
    container.style.removeProperty('--auto-scroll-duration');
    if (!content || container.closest('[hidden]')) {
      return;
    }
    const distance = Math.ceil(content.scrollWidth - container.clientWidth);
    if (distance <= 2) {
      return;
    }
    container.style.setProperty('--auto-scroll-distance', `${distance}px`);
    container.style.setProperty('--auto-scroll-duration', `${Math.max(8, 5 + distance / 22)}s`);
    container.classList.add('is-overflowing');
  });
}

let autoScrollFrame;
function scheduleAutoScrollUpdate() {
  cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = requestAnimationFrame(updateAutoScroll);
}

window.addEventListener('resize', scheduleAutoScrollUpdate);
window.addEventListener('resize', scheduleRunningAppNavigatorUpdate);
window.addEventListener('scroll', scheduleRunningAppNavigatorUpdate, { passive: true });

function sharedPortWarningText(draft, serviceIndex) {
  const port = Number(draft?.services?.[serviceIndex]?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '';
  }
  const folder = String(draft?.folder || '').trim();
  const sharedWith = state.projects.filter((project) => project.id !== draft?.id
    && String(project.folder || '').trim() !== folder
    && project.services?.some((service) => service.port === port));
  if (!sharedWith.length) {
    return '';
  }
  const names = sharedWith.map((project) => project.name).join(', ');
  return `Port :${port} is also used by ${names}. These projects can be saved, but cannot run together.`;
}

function updateSharedPortWarning(draft = currentDraft()) {
  document.querySelectorAll('[data-service-warning]').forEach((warning) => {
    warning.textContent = sharedPortWarningText(draft, Number(warning.dataset.serviceWarning));
    warning.hidden = !warning.textContent;
  });
}

function renderProjectForm(mode) {
  const editing = mode === 'edit';
  const reviewing = editing && state.reviewRequired;
  const errors = state.formErrors || {};
  const errorAttributes = (field) => errors[field]
    ? `aria-invalid="true" aria-describedby="${field}-error"`
    : 'aria-invalid="false"';
  const fieldError = (field) => errors[field]
    ? `<p id="${field}-error" class="field-error" role="alert">${escapeHtml(errors[field])}</p>`
    : '';
  const services = state.draft.services || [];
  const serviceRows = services.map((service, index) => {
    const nameField = `service-name-${index}`;
    const portField = `service-port-${index}`;
    const urlField = `service-url-${index}`;
    const warning = sharedPortWarningText(state.draft, index);
    const removeLabel = String(service.name || '').trim()
      ? `Remove ${String(service.name).trim()} service`
      : `Remove service ${index + 1}`;
    return `
      <div class="service-row" data-service-index="${index}">
        <div class="service-field">
          <label class="visually-hidden" for="${nameField}">Service ${index + 1} name</label>
          <input id="${nameField}" class="service-input" name="serviceName" value="${escapeHtml(String(service.name ?? ''))}" placeholder="web" maxlength="64" ${errorAttributes(nameField)}>
          ${fieldError(nameField)}
        </div>
        <div class="service-field">
          <label class="visually-hidden" for="${portField}">Service ${index + 1} port</label>
          <input id="${portField}" class="service-input" name="servicePort" type="number" min="1" max="65535" step="1" inputmode="numeric" value="${escapeHtml(String(service.port ?? ''))}" placeholder="3000" ${errorAttributes(portField)}>
          ${fieldError(portField)}
        </div>
        <button class="service-remove-button" type="button" data-action="remove-service" data-service-index="${index}" aria-label="${escapeHtml(removeLabel)}" title="Remove service">${icon('trash')}</button>
        <div class="service-field service-url-field">
          <label class="service-url-label" for="${urlField}">Open URL <span class="optional-label">Optional</span></label>
          <input id="${urlField}" class="service-input" name="serviceUrl" type="url" inputmode="url" value="${escapeHtml(String(service.url ?? ''))}" placeholder="https://app.local/dashboard" maxlength="2048" autocomplete="off" spellcheck="false" aria-label="Service ${index + 1} open URL, optional" ${errorAttributes(urlField)}>
          ${fieldError(urlField)}
        </div>
        <p class="shared-port-warning service-warning" data-service-warning="${index}" role="status" ${warning ? '' : 'hidden'}>${escapeHtml(warning)}</p>
      </div>`;
  }).join('');
  app.innerHTML = `
    <section class="add-screen">
      <header class="screen-header">
        <h2>${reviewing ? 'Review project setup' : editing ? 'Edit project' : 'Add project'}</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close ${reviewing ? 'review' : editing ? 'edit' : 'add'} project screen">${icon('close')}</button>
      </header>
      <p class="screen-copy">${reviewing ? 'A coding agent added or updated this setup. Check its folder, commands, and services before approving.' : editing ? `Update ${escapeHtml(state.draft.name || 'this project')} and its saved setup.` : 'Choose a folder and save its commands and services once.'}</p>
      <form id="project-form" novalidate>
        ${errors.form ? `<p id="form-error-summary" class="form-error-summary" role="alert" tabindex="-1">${escapeHtml(errors.form)}</p>` : ''}
        <label for="project-name">Project name <span class="optional-label">Optional</span></label>
        <input id="project-name" name="name" value="${escapeHtml(state.draft.name || '')}" placeholder="Defaults to folder name" maxlength="100" ${errorAttributes('project-name')}>
        ${fieldError('project-name')}

        <label for="folder">Project folder</label>
        <div class="folder-control">
          <input id="folder" name="folder" value="${escapeHtml(state.draft.folder || '')}" placeholder="Choose a folder" ${errorAttributes('folder')}>
          <button class="browse-button" type="button" data-action="pick-folder">Browse</button>
        </div>
        ${state.canUseCurrentWorkspace ? '<button class="workspace-button" type="button" data-action="use-current-workspace">Use current workspace</button>' : ''}
        ${fieldError('folder')}

        <label for="start-command">Start command</label>
        <input id="start-command" name="startCommand" value="${escapeHtml(state.draft.startCommand || '')}" placeholder="npm run dev" ${errorAttributes('start-command')}>
        ${fieldError('start-command')}

        <label for="stop-command">Custom stop command <span class="optional-label">Optional</span></label>
        <input id="stop-command" name="stopCommand" value="${escapeHtml(state.draft.stopCommand || '')}" placeholder="docker compose down" ${errorAttributes('stop-command')}>
        ${fieldError('stop-command')}
        <p class="field-hint">Leave empty to stop only the process tree Runlist started.</p>

        <fieldset id="services" class="service-editor" ${state.servicesLocked ? 'disabled' : ''} ${errors.services ? 'aria-invalid="true" aria-describedby="services-hint services-error" tabindex="-1"' : 'aria-describedby="services-hint"'}>
          <legend>Services <span class="optional-label">Optional</span></legend>
          <p id="services-hint" class="field-hint">${state.servicesLocked ? 'Stop this project before changing its services.' : 'Names and ports confirm what is running. An optional HTTP or HTTPS URL changes where Open app goes. Up to 32 services.'}</p>
          ${errors.services ? `<p id="services-error" class="field-error" role="alert">${escapeHtml(errors.services)}</p>` : ''}
          <div class="service-list-header" aria-hidden="true"><span>Name</span><span>Port</span></div>
          <div class="service-list">
            ${serviceRows || '<p class="empty-services">No services configured.</p>'}
          </div>
          <button class="service-add-button" type="button" data-action="add-service" ${services.length >= 32 ? 'disabled' : ''}>Add service</button>
        </fieldset>

        <button class="primary-button save-button" type="submit">${reviewing ? 'Approve setup' : editing ? 'Save changes' : 'Save project'}</button>
        <p class="form-hint">${reviewing ? 'Approving makes Start and Stop available for this project.' : editing ? 'Changes apply the next time you start this project.' : 'Commands run inside the selected folder.'}</p>
      </form>
    </section>`;
}

function renderAgentSetup() {
  const agentCard = (id, name, description) => {
    const connection = state.agentConnections?.[id] || { status: 'idle', message: '' };
    const busy = connection.status === 'loading';
    const registered = connection.status === 'success';
    const messageId = `${id}-connection-message`;
    return `
      <article class="agent-card">
        <div class="agent-card-heading">
          <div>
            <h3>${escapeHtml(name)}</h3>
            <p>${escapeHtml(description)}</p>
          </div>
          ${registered ? '<span class="connection-label"><span class="status-dot running" aria-hidden="true"></span>Ready</span>' : ''}
        </div>
        <button class="secondary-button agent-register-button" data-action="register-agent" data-agent="${id}" ${busy ? 'disabled aria-busy="true"' : ''} ${connection.message ? `aria-describedby="${messageId}"` : ''}>
          ${busy ? 'Setting up…' : registered ? 'Refresh setup' : 'Set up'}
        </button>
        ${connection.message ? `<p id="${messageId}" class="connection-message ${connection.status}" ${connection.status === 'error' ? 'role="alert"' : 'role="status"'}>${escapeHtml(connection.message)}</p>` : ''}
      </article>`;
  };

  app.innerHTML = `
    <section class="agent-screen">
      <header class="screen-header">
        <h2>Agent connections</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close agent connections screen">${icon('close')}</button>
      </header>
      <p class="screen-copy">Connect Runlist and add its guided project setup skill.</p>
      <div class="agent-list" aria-label="Supported coding agents">
        ${agentCard('copilot', 'GitHub Copilot', 'Adds /runlist. The connection is discovered automatically through VS Code.')}
        ${agentCard('codex', 'Codex', 'Registers the connection and adds $runlist.')}
        ${agentCard('claude', 'Claude Code', 'Registers the connection and adds /runlist.')}
      </div>
      <p class="agent-footnote">The skill inspects exact project commands and service ports, then saves them through Runlist.</p>
    </section>`;
}

function renderProjectOutput() {
  const projectOutput = state.projectOutput || { entries: [], name: 'Project', output: '' };
  app.innerHTML = `
    <section class="output-screen">
      <header class="screen-header">
        <h2>Recent output</h2>
        <div class="screen-header-actions">
          <button class="output-copy-button" data-action="copy-output" ${projectOutput.output ? '' : 'disabled'}>Copy output</button>
          <button class="icon-button" data-action="close-screen" aria-label="Close recent output">${icon('close')}</button>
        </div>
      </header>
      <p class="screen-copy">${escapeHtml(projectOutput.name)}</p>
      <div id="project-output-failure">${outputFailureSummaryHtml(projectOutput.failureSummary)}</div>
      ${projectOutput.canAskAgent ? `<button class="diagnosis-open-button" data-action="ask-agent" data-id="${escapeHtml(projectOutput.projectId)}">Ask your agent</button>` : ''}
      <div class="output-panel-wrap">
        <div class="output-panel" data-empty="${projectOutput.output ? 'false' : 'true'}" tabindex="0" aria-label="Recent output for ${escapeHtml(projectOutput.name)}">
          <div id="project-output">${outputEntriesHtml(projectOutput.entries, projectOutput.failureSummary)}</div>
        </div>
        <button class="output-jump-button" data-action="jump-latest" hidden>
          ${icon('chevron-down', 'jump-icon')}Latest
        </button>
      </div>
      <span id="output-update-status" class="visually-hidden" aria-live="polite"></span>
      <p class="output-hint">Output is kept for the latest run in this VS Code window.</p>
    </section>`;
  requestAnimationFrame(() => {
    const outputPanel = document.querySelector('.output-panel');
    if (outputPanel) {
      outputPanel.scrollTop = outputPanel.scrollHeight;
      outputFollowLatest = true;
      outputPanel.addEventListener('scroll', handleOutputScroll, { passive: true });
    }
  });
}

function renderProjectDiagnosis() {
  const diagnosis = state.diagnosis;
  if (!diagnosis) {
    app.innerHTML = '<section class="diagnosis-screen"><p class="screen-copy">These diagnostics are no longer available.</p></section>';
    return;
  }
  app.innerHTML = `
    <section class="diagnosis-screen">
      <header class="screen-header">
        <h2>Ask your agent</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close agent diagnosis">${icon('close')}</button>
      </header>
      <p class="screen-copy">Prepare ${escapeHtml(diagnosis.name)}'s latest failed start for diagnosis.</p>
      <div class="diagnosis-notice">
        <strong>Nothing is sent automatically</strong>
        <p>Runlist copies a short request for you to paste into your agent. The agent can then retrieve only this project's retained failure through Runlist.</p>
      </div>
      <h3 class="diagnosis-heading">Context available</h3>
      <ul class="diagnosis-context">
        <li>Project name and saved folder</li>
        <li>Saved start command, with credential-like values redacted</li>
        <li>Configured service names and ports</li>
        <li>Platform, last observed state, and exit result</li>
        <li>Concise failure summary</li>
        <li>Sanitized recent output${diagnosis.outputAvailable ? diagnosis.outputTruncated ? ' (latest portion)' : '' : ' (no command output was captured)'}</li>
      </ul>
      <p class="diagnosis-exclusion">Runlist does not provide environment variables, source files, shell history, process environments, or unconfigured network data.</p>
      <button class="primary-button diagnosis-copy-button" data-action="copy-diagnosis-request">Copy diagnosis request</button>
      <p id="diagnosis-copy-status" class="diagnosis-copy-status" aria-live="polite">Copy the request, then paste it into your agent chat.</p>
      ${diagnosis.agentReady ? '' : `
        <div class="diagnosis-setup">
          <strong>Need to connect an agent?</strong>
          <p>Use Runlist's existing Agent connections screen for Copilot, Codex, or Claude.</p>
          <button class="secondary-button" data-action="show-agent-connections">Open Agent connections</button>
        </div>`}
      <p class="diagnosis-review-note">Any command or service change proposed by an agent still requires your review and approval in Runlist.</p>
    </section>`;
}

function outputIsNearBottom(panel) {
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 32;
}

function updateOutputJumpButton() {
  const button = document.querySelector('.output-jump-button');
  if (button) {
    button.hidden = outputFollowLatest;
  }
}

function handleOutputScroll(event) {
  outputFollowLatest = outputIsNearBottom(event.currentTarget);
  if (outputFollowLatest) {
    clearOutputUpdateStatus();
  }
  updateOutputJumpButton();
}

function clearOutputUpdateStatus() {
  const status = document.getElementById('output-update-status');
  if (status) {
    status.textContent = '';
  }
}

function jumpToLatestOutput() {
  const panel = document.querySelector('.output-panel');
  if (!panel) {
    return;
  }
  outputFollowLatest = true;
  panel.scrollTop = panel.scrollHeight;
  clearOutputUpdateStatus();
  updateOutputJumpButton();
  panel.focus();
}

function currentDraft(form = document.getElementById('project-form')) {
  const fieldValue = (name) => form?.elements.namedItem(name)?.value || '';
  return {
    id: state.draft.id,
    name: fieldValue('name'),
    folder: fieldValue('folder'),
    startCommand: fieldValue('startCommand'),
    stopCommand: fieldValue('stopCommand'),
    services: [...(form?.querySelectorAll('.service-row') || [])].map((row) => ({
      name: row.querySelector('[name="serviceName"]')?.value || '',
      port: row.querySelector('[name="servicePort"]')?.value || '',
      url: row.querySelector('[name="serviceUrl"]')?.value || ''
    }))
  };
}

function clearServiceErrors() {
  for (const field of Object.keys(state.formErrors || {})) {
    if (field === 'services' || field.startsWith('service-')) {
      delete state.formErrors[field];
    }
  }
}

function updateServiceDraft(services, focusId) {
  state.draft = { ...currentDraft(), services };
  clearServiceErrors();
  vscode.postMessage({ type: 'updateDraft', draft: state.draft });
  renderProjectForm(state.mode);
  requestAnimationFrame(() => document.getElementById(focusId)?.focus());
}

app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    closeMenus();
    return;
  }

  if (button.dataset.action !== 'toggle-menu') {
    closeMenus();
  }

  const actions = {
    'show-add': () => vscode.postMessage({ type: 'showAdd' }),
    'close-screen': () => vscode.postMessage({
      type: 'closeScreen',
      draft: document.getElementById('project-form') ? currentDraft() : undefined
    }),
    'pick-folder': () => vscode.postMessage({ type: 'pickFolder', draft: currentDraft() }),
    'use-current-workspace': () => vscode.postMessage({ type: 'useCurrentWorkspace', draft: currentDraft() }),
    'add-service': () => {
      const services = currentDraft().services;
      if (services.length < 32) {
        const index = services.length;
        updateServiceDraft([...services, { name: '', port: '', url: '' }], `service-name-${index}`);
      }
    },
    'remove-service': () => {
      const index = Number(button.dataset.serviceIndex);
      const services = currentDraft().services.filter((service, serviceIndex) => serviceIndex !== index);
      const focusId = services.length
        ? `service-name-${Math.min(index, services.length - 1)}`
        : undefined;
      updateServiceDraft(services, focusId);
      if (!focusId) {
        requestAnimationFrame(() => document.querySelector('[data-action="add-service"]')?.focus());
      }
    },
    'register-agent': () => vscode.postMessage({ type: 'registerAgent', agent: button.dataset.agent }),
    'show-agent-connections': () => vscode.postMessage({ type: 'showAgentSetup' }),
    'toggle-menu': () => toggleMenu(button),
    open: () => {
      closeMenus();
      vscode.postMessage({ type: 'openProject', id: button.dataset.id });
    },
    'copy-service-url': () => vscode.postMessage({
      type: 'copyServiceUrl',
      id: button.dataset.id,
      port: Number(button.dataset.port)
    }),
    'toggle-preview': () => vscode.postMessage({
      type: 'toggleProjectPreview',
      id: button.dataset.id
    }),
    'refresh-preview': () => refreshProjectPreview(button.dataset.id),
    'open-vscode': () => {
      closeMenus();
      vscode.postMessage({ type: 'openProjectFolder', id: button.dataset.id });
    },
    'open-terminal': () => {
      closeMenus();
      vscode.postMessage({ type: 'openProjectTerminal', id: button.dataset.id });
    },
    'copy-project-path': () => {
      closeMenus();
      vscode.postMessage({ type: 'copyProjectPath', id: button.dataset.id });
    },
    output: () => {
      closeMenus();
      vscode.postMessage({ type: 'showOutput', id: button.dataset.id });
    },
    'ask-agent': () => vscode.postMessage({ type: 'showDiagnosis', id: button.dataset.id }),
    'copy-diagnosis-request': () => vscode.postMessage({ type: 'copyDiagnosisRequest' }),
    'open-output-url': () => {
      event.preventDefault();
      vscode.postMessage({ type: 'openOutputUrl', url: button.dataset.url });
    },
    'jump-latest': jumpToLatestOutput,
    'copy-output': () => vscode.postMessage({ type: 'copyOutput' }),
    edit: () => vscode.postMessage({ type: 'showEdit', id: button.dataset.id }),
    'toggle-pin': () => vscode.postMessage({ type: 'toggleProjectPin', id: button.dataset.id }),
    'show-running-app': () => revealRunningApp(button.dataset.id),
    'previous-running-app': () => navigateRunningApps(-1),
    'next-running-app': () => navigateRunningApps(1),
    delete: () => vscode.postMessage({ type: 'deleteProject', id: button.dataset.id }),
    start: () => vscode.postMessage({ type: 'startProject', id: button.dataset.id }),
    stop: () => vscode.postMessage({ type: 'stopProject', id: button.dataset.id }),
    restart: () => vscode.postMessage({ type: 'restartProject', id: button.dataset.id }),
    handoff: () => {
      button.disabled = true;
      vscode.postMessage({ type: 'handoffProject', id: button.dataset.id });
    },
    'stop-all': () => {
      button.disabled = true;
      button.innerHTML = `${productIcon('loading', 'status-progress')}Stopping all…`;
      vscode.postMessage({ type: 'stopAllProjects' });
    }
  };

  actions[button.dataset.action]?.();
});

app.addEventListener('dblclick', (event) => {
  const target = event.target.closest('.running-app-thumbnail-target[data-id]');
  if (target?.dataset.canOpen === 'true') {
    vscode.postMessage({ type: 'openProject', id: target.dataset.id });
  }
});

function loadProjectPreview(frame) {
  const wrapper = frame.closest('.preview-frame-wrap');
  const loading = wrapper?.querySelector('[data-preview-loading]');
  const fallback = wrapper?.querySelector('[data-preview-fallback]');
  const source = frame.dataset.src;
  if (!wrapper || !source) {
    return;
  }

  wrapper.classList.remove('loaded');
  loading.hidden = false;
  fallback.hidden = true;
  const generation = ++previewLoadGeneration;
  clearTimeout(previewLoadTimer);
  previewLoadTimer = setTimeout(() => {
    if (generation !== previewLoadGeneration) {
      return;
    }
    loading.hidden = true;
    fallback.hidden = false;
  }, 8000);
  frame.addEventListener('load', () => {
    if (generation !== previewLoadGeneration) {
      return;
    }
    clearTimeout(previewLoadTimer);
    wrapper.classList.add('loaded');
    loading.hidden = true;
    fallback.hidden = true;
  }, { once: true });
  frame.addEventListener('error', () => {
    if (generation !== previewLoadGeneration) {
      return;
    }
    clearTimeout(previewLoadTimer);
    loading.hidden = true;
    fallback.hidden = false;
  }, { once: true });
  frame.src = source;
}

function refreshProjectPreview(id) {
  const frame = document.querySelector(`.project-row[data-project-id="${CSS.escape(id)}"] [data-preview-frame]`);
  if (frame) {
    loadProjectPreview(frame);
  }
}

function initializeProjectPreview() {
  document.querySelectorAll('[data-preview-frame]').forEach(loadProjectPreview);
}

let timelineClock;
function updateTimelineElapsed() {
  document.querySelectorAll('[data-timeline-elapsed]').forEach((element) => {
    if (!element.dataset.startedAt) {
      return;
    }
    const startedAt = Number(element.dataset.startedAt);
    const readyAt = element.dataset.readyAt ? Number(element.dataset.readyAt) : undefined;
    if (!Number.isFinite(startedAt)) {
      return;
    }
    element.textContent = Number.isFinite(readyAt)
      ? `Ready in ${formatElapsed(readyAt - startedAt)}`
      : `Elapsed ${formatElapsed(Date.now() - startedAt)}`;
  });
}

function initializeTimelineClock() {
  clearInterval(timelineClock);
  timelineClock = undefined;
  const elapsed = document.querySelector('[data-timeline-elapsed]');
  if (!elapsed) {
    return;
  }
  updateTimelineElapsed();
  if (document.querySelector('[data-timeline-elapsed][data-ready-at=""]')) {
    timelineClock = setInterval(updateTimelineElapsed, 1000);
  }
}

window.addEventListener('message', (event) => {
  if (event.data?.messageToken !== state.messageToken) {
    return;
  }
  if (event.data?.type === 'projectMetrics') {
    const metrics = document.querySelector(`[data-resource-metrics][data-project-id="${CSS.escape(String(event.data.id || ''))}"]`);
    if (metrics) {
      metrics.innerHTML = resourceMetricsContent(event.data.metrics, event.data.runtimePulse);
      metrics.setAttribute('aria-label', resourceMetricsLabel(event.data.metrics));
    }
    return;
  }
  if (event.data?.type === 'projectOutputPeek') {
    updateProjectOutputPeek(event.data.id, event.data.entries);
    return;
  }
  if (event.data?.type === 'diagnosisRequestCopied') {
    const status = document.getElementById('diagnosis-copy-status');
    if (status) {
      status.textContent = 'Diagnosis request copied. Paste it into your agent chat.';
    }
    return;
  }
  if (event.data?.type !== 'projectOutput') {
    return;
  }
  const outputPanel = document.querySelector('.output-panel');
  const output = document.getElementById('project-output');
  if (!outputPanel || !output) {
    return;
  }
  const shouldFollow = outputFollowLatest || outputIsNearBottom(outputPanel);
  const previousScrollTop = outputPanel.scrollTop;
  const focusedLink = focusedOutputLink(output);
  const failure = document.getElementById('project-output-failure');
  if (failure) {
    failure.innerHTML = outputFailureSummaryHtml(event.data.failureSummary);
  }
  outputPanel.dataset.empty = String(!event.data.output);
  output.innerHTML = outputEntriesHtml(event.data.entries, event.data.failureSummary);
  const copyButton = document.querySelector('.output-copy-button');
  if (copyButton) {
    copyButton.disabled = !event.data.output;
  }
  if (shouldFollow) {
    outputFollowLatest = true;
    outputPanel.scrollTop = outputPanel.scrollHeight;
    clearOutputUpdateStatus();
  } else {
    outputFollowLatest = false;
    outputPanel.scrollTop = previousScrollTop;
    const status = document.getElementById('output-update-status');
    if (status) {
      status.textContent = 'New output is available.';
    }
  }
  restoreOutputLinkFocus(output, focusedLink);
  updateOutputJumpButton();
});

function outputPeekInteractionActive(slot) {
  if (slot.contains(document.activeElement)) {
    return true;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  try {
    return selection.getRangeAt(0).intersectsNode(slot);
  } catch {
    return false;
  }
}

function updateProjectOutputPeek(id, entries) {
  const key = String(id || '');
  const slot = document.querySelector(`[data-output-peek-slot][data-project-id="${CSS.escape(key)}"]`);
  if (!slot) {
    pendingOutputPeeks.delete(key);
    return;
  }
  if (outputPeekInteractionActive(slot)) {
    pendingOutputPeeks.set(key, entries || []);
    return;
  }
  pendingOutputPeeks.delete(key);
  slot.innerHTML = projectOutputPeekHtml(entries || [], key, slot.dataset.projectName || 'project');
}

function flushPendingOutputPeeks() {
  for (const [id, entries] of [...pendingOutputPeeks]) {
    updateProjectOutputPeek(id, entries);
  }
}

document.addEventListener('focusout', () => setTimeout(flushPendingOutputPeeks, 0));
document.addEventListener('selectionchange', flushPendingOutputPeeks);

function focusedOutputLink(output) {
  const active = document.activeElement;
  if (!active?.matches('.output-url') || !output.contains(active)) {
    return undefined;
  }
  const matchingLinks = [...output.querySelectorAll('.output-url')]
    .filter((link) => link.dataset.url === active.dataset.url);
  return {
    occurrence: matchingLinks.indexOf(active),
    url: active.dataset.url
  };
}

function restoreOutputLinkFocus(output, focusedLink) {
  if (!focusedLink) {
    return;
  }
  const matchingLinks = [...output.querySelectorAll('.output-url')]
    .filter((link) => link.dataset.url === focusedLink.url);
  matchingLinks[focusedLink.occurrence]?.focus({ preventScroll: true });
}

window.addEventListener('message', (event) => {
  if (event.data?.messageToken !== state.messageToken || event.data?.type !== 'outputCopied') {
    return;
  }
  const copyButton = document.querySelector('.output-copy-button');
  if (!copyButton) {
    return;
  }
  copyButton.textContent = 'Copied';
  setTimeout(() => {
    copyButton.textContent = 'Copy output';
  }, 1500);
});

window.addEventListener('message', (event) => {
  if (event.data?.messageToken !== state.messageToken || event.data?.type !== 'restoreProjectMenuFocus') {
    return;
  }
  closeMenus();
  document.querySelector(`.more-button[data-id="${CSS.escape(event.data.id)}"]`)?.focus();
});

app.addEventListener('submit', (event) => {
  if (event.target.id !== 'project-form') {
    return;
  }
  event.preventDefault();
  vscode.postMessage({ type: 'saveProject', project: currentDraft(event.target) });
});

app.addEventListener('input', (event) => {
  if (event.target.form?.id !== 'project-form') {
    return;
  }
  const field = event.target.id;
  if (event.target.classList.contains('service-input')) {
    clearServiceErrors();
    document.querySelectorAll('.service-input').forEach((input) => {
      input.setAttribute('aria-invalid', 'false');
      input.removeAttribute('aria-describedby');
    });
    document.querySelectorAll('.service-field .field-error').forEach((error) => error.remove());
    document.getElementById('services-error')?.remove();
  } else {
    delete state.formErrors?.[field];
    event.target.setAttribute('aria-invalid', 'false');
    event.target.removeAttribute('aria-describedby');
    document.getElementById(`${field}-error`)?.remove();
  }
  const draft = currentDraft();
  updateSharedPortWarning(draft);
  vscode.postMessage({ type: 'updateDraft', draft });
});

app.addEventListener('focusin', (event) => {
  const element = event.target;
  let target;
  if (element.matches('.run-button[data-id]')) {
    target = { type: 'project-control', id: element.dataset.id };
  } else if (element.matches('.more-button[data-id]')) {
    target = { type: 'project-menu', id: element.dataset.id };
  } else if (element.id) {
    target = { type: 'field', id: element.id };
  } else if (element.dataset.action) {
    target = {
      type: 'action',
      action: element.dataset.action,
      id: element.dataset.id,
      agent: element.dataset.agent
    };
  }
  if (target) {
    vscode.postMessage({ type: 'setFocusTarget', target });
  }
});

function handleSearchInput(event) {
  const query = event.currentTarget.value;
  vscode.postMessage({ type: 'setSearchQuery', query });
  closeMenus();
  applyProjectFilter(query);
}

document.addEventListener('keydown', (event) => {
  const menu = event.target.closest('.action-menu');
  if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) {
      return;
    }
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  }

  if (event.key === 'Escape') {
    const trigger = document.querySelector('.more-button[aria-expanded="true"]');
    closeMenus();
    trigger?.focus();
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.action-menu, .more-button')) {
    closeMenus();
  }
}, true);

window.addEventListener('blur', () => closeMenus());

app.addEventListener('focusout', () => {
  requestAnimationFrame(() => {
    const openMenu = document.querySelector('.action-menu:not([hidden])');
    if (!openMenu) {
      return;
    }
    const trigger = document.querySelector(`.more-button[data-id="${CSS.escape(openMenu.dataset.menuId)}"]`);
    if (!openMenu.contains(document.activeElement) && document.activeElement !== trigger) {
      closeMenus();
    }
  });
});

function closeMenus(exceptId) {
  document.querySelectorAll('.action-menu').forEach((menu) => {
    const isOpenMenu = menu.dataset.menuId === exceptId;
    menu.hidden = !isOpenMenu;
    menu.classList.remove('open-up');
    const trigger = document.querySelector(`.more-button[data-id="${CSS.escape(menu.dataset.menuId)}"]`);
    trigger?.setAttribute('aria-expanded', String(isOpenMenu));
  });
}

function toggleMenu(button) {
  const menu = document.querySelector(`.action-menu[data-menu-id="${CSS.escape(button.dataset.id)}"]`);
  const shouldOpen = menu?.hidden;
  closeMenus(shouldOpen ? button.dataset.id : undefined);
  if (!shouldOpen) {
    return;
  }

  requestAnimationFrame(() => {
    const menuBounds = menu.getBoundingClientRect();
    if (menuBounds.bottom > window.innerHeight - 8) {
      menu.classList.add('open-up');
    }
    menu.querySelector('button:not(:disabled)')?.focus();
  });
}

function applyInitialFocus() {
  const target = state.focusTarget;
  if (!target) {
    return;
  }
  let element;
  if (target.type === 'field') {
    element = document.getElementById(target.id);
  } else if (target.type === 'project-menu') {
    element = document.querySelector(`.more-button[data-id="${CSS.escape(target.id)}"]`);
  } else if (target.type === 'project-control') {
    element = document.querySelector(`.run-button[data-id="${CSS.escape(target.id)}"]`);
  } else if (target.type === 'action') {
    let selector = `[data-action="${CSS.escape(target.action)}"]`;
    if (target.id) {
      selector += `[data-id="${CSS.escape(target.id)}"]`;
    }
    if (target.agent) {
      selector += `[data-agent="${CSS.escape(target.agent)}"]`;
    }
    element = document.querySelector(selector);
  }
  requestAnimationFrame(() => element?.focus());
}

if (state.mode === 'list') {
  renderList();
  document.getElementById('project-search')?.addEventListener('input', handleSearchInput);
  scheduleAutoScrollUpdate();
  scheduleRunningAppNavigatorUpdate();
  initializeProjectPreview();
  initializeTimelineClock();
} else if (state.mode === 'agents') {
  renderAgentSetup();
} else if (state.mode === 'output') {
  renderProjectOutput();
} else if (state.mode === 'diagnosis') {
  renderProjectDiagnosis();
} else {
  renderProjectForm(state.mode);
}

applyInitialFocus();
