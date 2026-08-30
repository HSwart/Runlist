const vscode = acquireVsCodeApi();
const state = window.runlistState;
const { createWebviewMessageRouter } = window.RunlistMessageRouter;
const { projectCanRelinkFolder, projectPrimaryAction } = window.RunlistProjectActions;
const {
  projectDisplayedStatus,
  projectRowReadinessStatusText,
  projectShowsMissingFolder,
  projectStartFailureText,
  projectStatusAnnouncement,
  projectStatusDetailText,
  projectStatusFullLabels,
  projectStopFailureText
} = window.RunlistProjectStatus;
const app = document.getElementById('app');
const persistedWebviewState = vscode.getState() || {};
const detailTabState = { ...(persistedWebviewState.detailTabs || {}) };
const phoneHandoffState = { ...(persistedWebviewState.phoneHandoffs || {}) };
const startupFailureState = { ...(persistedWebviewState.startupFailures || {}) };
const expandedServiceState = { ...(persistedWebviewState.expandedServices || {}) };
const stateFilterRevision = Number.isSafeInteger(state.filterRevision)
  ? state.filterRevision
  : 0;
const persistedFilterRevision = Number.isSafeInteger(persistedWebviewState.filterRevision)
  ? persistedWebviewState.filterRevision
  : 0;
const persistedFilterIsNewer = persistedFilterRevision > stateFilterRevision;
let filterRevision = Math.max(stateFilterRevision, persistedFilterRevision);
let filterRevisionSeen = persistedFilterIsNewer
  ? persistedWebviewState.filterRevisionSeen === true || persistedFilterRevision > 0
  : state.filterRevisionSeen === true || stateFilterRevision > 0;
const initialSearchQuery = persistedFilterIsNewer
  ? persistedWebviewState.searchQuery
  : state.searchQuery;
const initialTagFilter = persistedFilterIsNewer
  ? persistedWebviewState.tagFilter
  : state.tagFilter;
let searchQuery = String(initialSearchQuery || '');
let selectedTagFilter = String(initialTagFilter || '');
const initialSelectionStart = persistedFilterIsNewer
  ? persistedWebviewState.searchSelectionStart
  : state.searchSelectionStart;
const initialSelectionEnd = persistedFilterIsNewer
  ? persistedWebviewState.searchSelectionEnd
  : state.searchSelectionEnd;
let searchSelectionStart = Number.isInteger(initialSelectionStart) ? initialSelectionStart : 0;
let searchSelectionEnd = Number.isInteger(initialSelectionEnd) ? initialSelectionEnd : 0;
let searchFocused = (persistedFilterIsNewer
  ? persistedWebviewState.searchFocused
  : state.searchFocused) === true;
if (searchSelectionStart < 0
  || searchSelectionEnd < searchSelectionStart
  || searchSelectionEnd > searchQuery.length) {
  searchSelectionStart = 0;
  searchSelectionEnd = 0;
  searchFocused = false;
}
let firstListRender = true;
let tagsExpanded = Boolean(persistedWebviewState.tagsExpanded);
let groupsExpanded = Boolean(persistedWebviewState.groupsExpanded);
let selectedGroupFilter = String(persistedWebviewState.groupFilter || '');
let reviewFilterActive = persistedWebviewState.reviewFilterActive === true;
let attentionFocusSignature = String(persistedWebviewState.attentionFocusSignature || '');
let lastAttentionFocusId = String(persistedWebviewState.lastAttentionFocusId || '');
let runGroupDraft = undefined;
let outputFollowLatest = true;
let announcedProjectStatuses = new Map();
let announcedFolderAccess = new Map();
let announcedPreviewFailures = new Map();
let previewLoadGeneration = 0;
let previewLoadTimer;
let activePreviewLoad;
let runningAppNavigatorFrame;
const pendingOutputPeeks = new Map();
const projectIncarnations = new Map(
  (state.projects || [])
    .filter((project) => typeof project.projectIncarnation === 'string'
      && project.projectIncarnation.length > 0
      && project.projectIncarnation.length <= 512)
    .map((project) => [String(project.id), project.projectIncarnation])
);
let projectIncarnationSequence = 0;

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function normalizeTagIdentity(value) {
  return String(value || '').trim().toLowerCase();
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

function formatResponseTime(value) {
  if (!Number.isFinite(value)) {
    return 'Unavailable';
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
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
  const pulseClass = key === 'cpuPercent' ? 'cpu' : key === 'memoryBytes' ? 'memory' : 'http';
  return `<svg class="runtime-pulse ${pulseClass}" viewBox="0 0 48 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polyline class="runtime-pulse-line" points="${points}" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

function httpResponseContent(httpResponsePulse = []) {
  const latest = httpResponsePulse.at(-1)?.responseTimeMs;
  return Number.isFinite(latest)
    ? `<span class="resource-reading http"><span><strong>HTTP</strong> <span data-http-response>${escapeHtml(formatResponseTime(latest))}</span></span>${runtimePulseSvg(httpResponsePulse, 'responseTimeMs')}</span>`
    : '';
}

function unavailableResourceText(metrics) {
  const message = String(metrics?.message || '');
  if (message.includes('window that started')) {
    return 'Start this project in this VS Code window to measure CPU and memory.';
  }
  if (message.includes('ownership')) {
    return 'CPU and memory stopped because this process is no longer owned here.';
  }
  return 'CPU and memory are not available for this run.';
}

function resourceMetricsContent(metrics, runtimePulse = [], httpResponsePulse = []) {
  const httpContent = httpResponseContent(httpResponsePulse);
  let processMetrics = '';
  if (metrics?.available) {
    const cpu = metrics.measuring ? 'Measuring…' : formatCpuPercent(metrics.cpuPercent);
    const memory = metrics.measuring ? 'Measuring…' : formatMemory(metrics.memoryBytes);
    processMetrics = `<span class="resource-reading"><span><strong>CPU</strong> <span data-resource-cpu>${escapeHtml(cpu)}</span></span>${runtimePulseSvg(runtimePulse, 'cpuPercent')}</span><span class="resource-reading"><span><strong>Memory</strong> <span data-resource-memory>${escapeHtml(memory)}</span></span>${runtimePulseSvg(runtimePulse, 'memoryBytes')}</span>`;
  } else {
    const message = unavailableResourceText(metrics);
    processMetrics = `<span class="resource-unavailable" title="${escapeHtml(message)}">${escapeHtml(message)}</span>`;
  }
  return `${processMetrics}${httpContent}`;
}

function resourceMetricsLabel(metrics, httpResponsePulse = []) {
  const parts = [];
  const latest = httpResponsePulse.at(-1)?.responseTimeMs;
  if (metrics?.available) {
    const cpu = metrics.measuring ? 'measuring' : formatCpuPercent(metrics.cpuPercent);
    const memory = metrics.measuring ? 'measuring' : formatMemory(metrics.memoryBytes);
    parts.push(`Resource use: CPU ${cpu}; memory ${memory}.`);
  } else {
    parts.push(unavailableResourceText(metrics));
  }
  if (Number.isFinite(latest)) {
    parts.push(`HTTP response time ${formatResponseTime(latest)}.`);
  }
  return parts.join(' ');
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
    'chevron-up': { viewBox: '0 0 16 16', body: '<path d="M3.646 10.354a.5.5 0 0 0 .708 0L8 6.707l3.646 3.647a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 0 0 0 .708Z"/>' },
    close: { viewBox: '0 0 16 16', body: '<path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/>' },
    copy: { viewBox: '0 0 16 16', body: '<path d="M4 4.5C4 3.672 4.672 3 5.5 3h6c.828 0 1.5.672 1.5 1.5v7c0 .828-.672 1.5-1.5 1.5h-6c-.828 0-1.5-.672-1.5-1.5v-7ZM5.5 4a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-6Z"/><path d="M2 3.5C2 2.672 2.672 2 3.5 2H10v1H3.5a.5.5 0 0 0-.5.5V11H2V3.5Z"/>' },
    edit: { viewBox: '0 0 16 16', body: '<path d="M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z"/>' },
    external: { viewBox: '0 0 16 16', body: '<path d="M15 9.5V12.5C15 13.879 13.879 15 12.5 15H3.5C2.121 15 1 13.879 1 12.5V3.5C1 2.121 2.121 1 3.5 1H6.5C6.776 1 7 1.224 7 1.5C7 1.776 6.776 2 6.5 2H3.5C2.673 2 2 2.673 2 3.5V12.5C2 13.327 2.673 14 3.5 14H12.5C13.327 14 14 13.327 14 12.5V9.5C14 9.224 14.224 9 14.5 9C14.776 9 15 9.224 15 9.5ZM14.5 1H9.5C9.224 1 9 1.224 9 1.5C9 1.776 9.224 2 9.5 2H13.293L9.147 6.146C8.952 6.341 8.952 6.658 9.147 6.853C9.245 6.951 9.373 6.999 9.501 6.999C9.629 6.999 9.757 6.95 9.855 6.853L14.001 2.707V6.5C14.001 6.776 14.225 7 14.501 7C14.777 7 15.001 6.776 15.001 6.5V1.5C15.001 1.224 14.777 1 14.501 1H14.5Z"/>' },
    folder: { viewBox: '0 0 16 16', body: '<path d="M2 4.5V6H5.58579C5.71839 6 5.84557 5.94732 5.93934 5.85355L7.29289 4.5L5.93934 3.14645C5.84557 3.05268 5.71839 3 5.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM1 4.5C1 3.11929 2.11929 2 3.5 2H5.58579C5.98361 2 6.36514 2.15804 6.64645 2.43934L8.20711 4H12.5C13.8807 4 15 5.11929 15 6.5V11.5C15 12.8807 13.8807 14 12.5 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5ZM2 7V11.5C2 12.3284 2.67157 13 3.5 13H12.5C13.3284 13 14 12.3284 14 11.5V6.5C14 5.67157 13.3284 5 12.5 5H8.20711L6.64645 6.56066C6.36514 6.84197 5.98361 7 5.58579 7H2Z"/>' },
    layers: { viewBox: '0 0 16 16', body: '<path fill-rule="evenodd" clip-rule="evenodd" d="M7.62706 1.08717L8.18535 1.08325L14.2762 5.1203L14.2727 5.95617L8.1818 9.91912L7.63062 9.91528L1.72152 5.95233L1.71796 5.12422L7.62706 1.08717ZM7.91335 2.10268L2.89198 5.53323L7.91329 8.90079L13.0891 5.5332L7.91335 2.10268ZM1.79257 8.5L7.63059 12.4153L8.18177 12.4191L14.2053 8.5H12.3716L7.91326 11.4008L3.58794 8.5H1.79257ZM7.63059 14.9153L1.79257 11H3.58794L7.91326 13.9008L12.3716 11H14.2053L8.18177 14.9191L7.63059 14.9153Z"/>' },
    loading: { viewBox: '0 0 16 16', body: '<path d="M13.5 8.5C13.224 8.5 13 8.276 13 8C13 5.243 10.757 3 8 3C5.243 3 3 5.243 3 8C3 8.276 2.776 8.5 2.5 8.5C2.224 8.5 2 8.276 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 8.276 13.776 8.5 13.5 8.5Z"/>' },
    more: { viewBox: '0 0 16 16', body: '<path d="M5 8C5 8.55229 4.55228 9 4 9C3.44772 9 3 8.55229 3 8C3 7.44772 3.44772 7 4 7C4.55228 7 5 7.44772 5 8ZM9 8C9 8.55229 8.55229 9 8 9C7.44772 9 7 8.55229 7 8C7 7.44772 7.44772 7 8 7C8.55229 7 9 7.44772 9 8ZM12 9C12.5523 9 13 8.55229 13 8C13 7.44772 12.5523 7 12 7C11.4477 7 11 7.44772 11 8C11 8.55229 11.4477 9 12 9Z"/>' },
    pin: { viewBox: '0 0 16 16', body: '<path d="M14 5v7h-.278c-.406 0-.778-.086-1.117-.258A2.528 2.528 0 0 1 11.73 11H8.87a3.463 3.463 0 0 1-.546.828 3.685 3.685 0 0 1-.735.633c-.27.177-.565.31-.882.398a3.875 3.875 0 0 1-.985.141h-.5V9H2l-1-.5L2 8h3.222V4h.5c.339 0 .664.047.977.14.312.094.607.227.883.4A3.404 3.404 0 0 1 8.87 6h2.859a2.56 2.56 0 0 1 .875-.734c.338-.172.71-.26 1.117-.266H14zm-.778 1.086a1.222 1.222 0 0 0-.32.156 1.491 1.491 0 0 0-.43.461L12.285 7H8.183l-.117-.336a2.457 2.457 0 0 0-.711-1.047C7.027 5.331 6.427 5.09 6 5v7c.427-.088 1.027-.33 1.355-.617.328-.287.565-.636.71-1.047L8.184 10h4.102l.18.297c.057.094.122.177.195.25.073.073.153.143.242.21.088.069.195.12.32.157V6.086z"/>' },
    pinned: { viewBox: '0 0 16 16', body: '<path d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z"/>' },
    play: { viewBox: '0 0 16 16', body: '<path d="M4.74514 3.06414C4.41183 2.87665 4 3.11751 4 3.49993V12.5002C4 12.8826 4.41182 13.1235 4.74512 12.936L12.7454 8.43601C13.0852 8.24486 13.0852 7.75559 12.7454 7.56443L4.74514 3.06414ZM3 3.49993C3 2.35268 4.2355 1.63011 5.23541 2.19257L13.2357 6.69286C14.2551 7.26633 14.2551 8.73415 13.2356 9.30759L5.23537 13.8076C4.23546 14.37 3 13.6474 3 12.5002V3.49993Z"/>' },
    refresh: { viewBox: '0 0 16 16', body: '<path d="M3 8C3 5.23858 5.23858 3 8 3C9.63527 3 11.0878 3.78495 12.0005 5H10C9.72386 5 9.5 5.22386 9.5 5.5C9.5 5.77614 9.72386 6 10 6H12.8904C12.8973 6.00014 12.9041 6.00014 12.911 6H13C13.2761 6 13.5 5.77614 13.5 5.5V2.5C13.5 2.22386 13.2761 2 13 2C12.7239 2 12.5 2.22386 12.5 2.5V4.03138C11.4009 2.78613 9.79253 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14C11.1301 14 13.6999 11.6035 13.9756 8.54488C14.0003 8.26985 13.7975 8.0268 13.5225 8.00202C13.2474 7.97723 13.0044 8.1801 12.9796 8.45512C12.75 11.003 10.6079 13 8 13C5.23858 13 3 10.7614 3 8Z"/>' },
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

function serviceLocalAddress(service, project = {}) {
  const hostname = project.localHostname
    || (typeof project.name === 'string' ? String(project.name) : '');
  const slug = hostname
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  const fullUrl = service.url || (slug
    ? `http://${slug}.localhost:${service.port}`
    : `http://localhost:${service.port}`);
  try {
    const parsed = new URL(fullUrl);
    const host = parsed.host.replace(/^127\.0\.0\.1(?=:|$)/, 'localhost');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return {
      fullUrl,
      label: `${host}${path}`
    };
  } catch {
    return {
      fullUrl: `localhost:${service.port}`,
      label: `localhost:${service.port}`
    };
  }
}

function readinessDetailsHtml(project, status) {
  const rows = [];
  const code = project.reviewRequired ? 'review-required' : (status || 'stopped');
  if (!project.forceClosing && !project.handoffInProgress) {
    const full = projectStatusFullLabels(project)[code];
    const primary = projectDisplayedStatus(project);
    if (full && full !== primary) {
      rows.push(`<span><strong>${escapeHtml(full)}</strong></span>`);
    }
  }
  if (['not-ready', 'not-responding'].includes(status)) {
    const details = project.serviceReadiness || {};
    if (details.ready?.length) {
      rows.push(`<span><strong>Ready:</strong> ${readinessServiceList(details.ready)}</span>`);
    }
    if (details.waiting?.length) {
      rows.push(`<span><strong>Still checking:</strong> ${readinessServiceList(details.waiting)}</span>`);
    }
    if (details.notResponding?.length) {
      rows.push(`<span><strong>Waiting for web response:</strong> ${readinessServiceList(details.notResponding)}</span>`);
    }
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

function projectRowElapsedStartedAt(project = {}) {
  const launchedAt = project.timeline?.launchedAt;
  if (!Number.isFinite(launchedAt)) {
    return undefined;
  }
  if (project.reviewRequired || project.forceClosing || project.handoffInProgress) {
    return undefined;
  }
  const status = project.status || 'stopped';
  if (!['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active'].includes(status)) {
    return undefined;
  }
  return launchedAt;
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
  const averageReadyDuration = Number.isFinite(project.averageReadyDurationMs)
    ? formatStartupDuration(project.averageReadyDurationMs)
    : undefined;
  const selectedFailureKey = startupFailureState[project.id];
  const selectedFailure = history.find((entry, index) => (
    entry.failureSummary && startupHistoryEntryKey(entry, index) === selectedFailureKey
  ));
  const failureDetailId = `startup-failure-${escapeHtml(String(project.id))}`;
  const summary = `Recent starts for ${project.name}, oldest to newest: ${history.map((entry) => {
    const outcome = labels[entry.outcome] || labels.failed;
    return `${outcome.label} after ${formatStartupDuration(entry.durationMs)}`;
  }).join('; ')}.`;
  return `
    <section class="startup-history" role="group" aria-label="${escapeHtml(summary)}">
      <header><strong>Recent starts</strong><span class="startup-history-stats">${averageReadyDuration !== undefined ? `<span aria-label="Average ready time: ${escapeHtml(averageReadyDuration)}">Avg ready ${escapeHtml(averageReadyDuration)}</span>` : ''}<span>${readyCount} of ${history.length} ready</span></span></header>
      <div class="startup-history-ribbon">
        ${history.map((entry, index) => {
          const outcome = labels[entry.outcome] || labels.failed;
          const duration = formatStartupDuration(entry.durationMs);
          const content = `<strong>${outcome.code}</strong><span>${escapeHtml(duration)}</span>`;
          if (!entry.failureSummary) {
            return `<span class="startup-history-entry ${escapeHtml(entry.outcome)}" title="${outcome.label} after ${escapeHtml(duration)}">${content}</span>`;
          }
          const entryKey = startupHistoryEntryKey(entry, index);
          const selected = entryKey === selectedFailureKey;
          return `<button type="button" class="startup-history-entry inspectable ${escapeHtml(entry.outcome)}" data-action="show-startup-failure" data-id="${escapeHtml(String(project.id))}" data-entry-key="${entryKey}" aria-label="View details for failed start after ${escapeHtml(duration)}" aria-expanded="${selected}" aria-controls="${failureDetailId}" title="View failure details">${content}</button>`;
        }).join('')}
      </div>
      ${selectedFailure ? `<section id="${failureDetailId}" class="startup-failure-detail" tabindex="-1" aria-label="Failure details for ${projectName}">
        <header><strong>Why it failed</strong><button type="button" class="icon-button" data-action="close-startup-failure" data-id="${escapeHtml(String(project.id))}" data-entry-key="${selectedFailureKey}" aria-label="Close failure details">${icon('close')}</button></header>
        <p>${escapeHtml(selectedFailure.failureSummary)}</p>
      </section>` : ''}
    </section>`;
}

function startupHistoryEntryKey(entry, index) {
  return `${Math.round(entry.completedAt)}-${Math.round(entry.durationMs)}-${index}`;
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
    ? `<button class="timeline-output-link" data-action="show-terminal" data-id="${escapeHtml(project.id)}">Show terminal</button>`
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
  const safeProjectId = escapeHtml(String(projectId || ''));
  const safeProjectName = escapeHtml(String(projectName || 'project'));
  return `
    <section class="project-output-peek" tabindex="0" aria-label="Latest output for ${safeProjectName}">
      <header><span>Live output</span><button data-action="show-terminal" data-id="${safeProjectId}">Show terminal</button></header>
      ${entries?.length
        ? `<ol>${outputPeekEntriesHtml(entries)}</ol>`
        : '<p class="output-peek-empty">No output yet.</p>'}
    </section>`;
}

const DETAIL_TAB_LABELS = {
  overview: 'Overview',
  services: 'Services',
  output: 'Output',
  preview: 'Preview',
  history: 'History'
};

function saveWebviewState() {
  vscode.setState({
    ...persistedWebviewState,
    detailTabs: detailTabState,
    phoneHandoffs: phoneHandoffState,
    startupFailures: startupFailureState,
    expandedServices: expandedServiceState,
    tagsExpanded,
    groupsExpanded,
    groupFilter: selectedGroupFilter,
    reviewFilterActive,
    filterRevisionSeen,
    filterRevision,
    searchQuery,
    tagFilter: selectedTagFilter,
    searchSelectionStart,
    searchSelectionEnd,
    searchFocused,
    attentionFocusSignature,
    lastAttentionFocusId
  });
}

function publishFilterState(type, sourceElement) {
  const input = sourceElement?.id === 'project-search'
    ? sourceElement
    : document.getElementById('project-search');
  const ownsSearchFocus = Boolean(input
    && input.id === 'project-search'
    && document.activeElement === input);
  const queryLength = searchQuery.length;
  const requestedStart = ownsSearchFocus && Number.isInteger(input.selectionStart)
    ? input.selectionStart
    : 0;
  const requestedEnd = ownsSearchFocus && Number.isInteger(input.selectionEnd)
    ? input.selectionEnd
    : 0;
  searchSelectionStart = Math.max(0, Math.min(queryLength, requestedStart));
  searchSelectionEnd = Math.max(searchSelectionStart, Math.min(queryLength, requestedEnd));
  searchFocused = ownsSearchFocus;
  filterRevision += 1;
  filterRevisionSeen = true;
  state.filterRevision = filterRevision;
  state.filterRevisionSeen = filterRevisionSeen;
  state.searchQuery = searchQuery;
  state.tagFilter = selectedTagFilter;
  state.searchSelectionStart = searchSelectionStart;
  state.searchSelectionEnd = searchSelectionEnd;
  state.searchFocused = searchFocused;
  saveWebviewState();
  vscode.postMessage({
    type,
    query: searchQuery,
    tag: selectedTagFilter,
    filterRevision,
    selectionStart: searchSelectionStart,
    selectionEnd: searchSelectionEnd,
    searchFocused
  });
}

function saveDetailTabState() {
  saveWebviewState();
}

function reconcilePerItemWebviewState(projects) {
  const validProjectIds = new Set();
  const validServicePorts = new Map();
  const hostProjectIncarnations = new Map();
  for (const project of projects || []) {
    const projectId = String(project.id);
    validProjectIds.add(projectId);
    validServicePorts.set(projectId, new Set((project.services || []).map((service) => String(service.port))));
    if (typeof project.projectIncarnation === 'string'
      && project.projectIncarnation.length > 0
      && project.projectIncarnation.length <= 512) {
      hostProjectIncarnations.set(projectId, project.projectIncarnation);
    }
  }

  for (const projectId of projectIncarnations.keys()) {
    if (!validProjectIds.has(String(projectId))) {
      projectIncarnations.delete(projectId);
    }
  }
  for (const projectId of validProjectIds) {
    if (hostProjectIncarnations.has(projectId)) {
      projectIncarnations.set(projectId, hostProjectIncarnations.get(projectId));
    } else if (!projectIncarnations.has(projectId)) {
      // Production renders seed this from the host-owned lifecycle map; this fallback
      // keeps legacy or isolated fixture state usable without persisting a token.
      projectIncarnationSequence += 1;
      projectIncarnations.set(projectId, `${projectId}:${projectIncarnationSequence}`);
    }
  }
  for (const projectId of announcedPreviewFailures.keys()) {
    if (!validProjectIds.has(String(projectId))) {
      announcedPreviewFailures.delete(projectId);
    }
  }

  let persistentStateChanged = false;
  for (const stateMap of [detailTabState, phoneHandoffState, startupFailureState]) {
    for (const key of Object.keys(stateMap)) {
      if (!validProjectIds.has(String(key))) {
        delete stateMap[key];
        persistentStateChanged = true;
      }
    }
  }
  for (const key of Object.keys(expandedServiceState)) {
    const servicePorts = validServicePorts.get(String(key));
    if (!servicePorts || !servicePorts.has(String(expandedServiceState[key]))) {
      delete expandedServiceState[key];
      persistentStateChanged = true;
    }
  }
  for (const key of pendingOutputPeeks.keys()) {
    if (!validProjectIds.has(String(key))) {
      pendingOutputPeeks.delete(key);
    }
  }
  return persistentStateChanged;
}

function selectedProjectDetailTab(project) {
  const tabs = project.detailTabs || ['overview'];
  const savedTab = detailTabState[project.id];
  const selected = tabs.includes(savedTab)
    ? savedTab
    : tabs.includes(project.defaultDetailTab)
      ? project.defaultDetailTab
      : 'overview';
  detailTabState[project.id] = selected;
  return selected;
}

function serviceDisplayDetails(project, service) {
  const projectStatus = project.status || 'stopped';
  const conflicted = ['port-in-use', 'port-in-use-unknown'].includes(projectStatus);
  const portOpen = project.openPorts?.includes(service.port);
  const portBlocked = conflicted
    && portOpen
    && project.portConflict?.port === service.port;
  const canUseUrl = project.serviceUrls?.some((entry) => entry.port === service.port)
    && !project.reviewRequired
    && !portBlocked;
  const webNotResponding = !portBlocked
    && portOpen
    && project.webPorts?.includes(service.port)
    && !project.respondingPorts?.includes(service.port);
  const waiting = ['starting', 'not-ready'].includes(projectStatus) && !portOpen;
  const canResolve = !project.reviewRequired
    && !project.lifecycleBlocked
    && !project.forceClosing
    && !project.handoffInProgress
    && (portBlocked || (projectStatus === 'not-ready' && waiting));
  const state = portBlocked
    ? 'Port in use'
    : webNotResponding
      ? 'No web response'
      : portOpen
        ? 'Ready'
        : waiting
          ? 'Waiting'
          : 'Stopped';
  const indicator = portBlocked
    ? 'conflict'
    : webNotResponding
      ? 'not-responding'
      : portOpen
        ? 'running'
        : '';
  return { canResolve, canUseUrl, indicator, state };
}

function projectRowPort(project) {
  if (Number.isInteger(project.previewPort) && project.previewPort > 0) {
    return project.previewPort;
  }
  const firstService = (project.services || []).find((service) => Number.isInteger(service.port) && service.port > 0);
  return firstService?.port;
}

function rowListenerOwnerVisible(owner, portConflict) {
  if (!owner || !owner.label) {
    return false;
  }
  if (owner.kind === 'other-runlist'
    && typeof portConflict?.ownerName === 'string'
    && portConflict.ownerName === owner.label) {
    return false;
  }
  return true;
}

function projectListenerOwnerHtml(project) {
  const owner = project.listenerOwner;
  if (!rowListenerOwnerVisible(owner, project.portConflict)) {
    return '';
  }
  const label = escapeHtml(owner.label);
  const title = escapeHtml(owner.title || owner.label);
  if (owner.kind === 'other-runlist' && owner.revealProjectId) {
    return `
                    <button type="button" class="project-listener-owner" data-action="reveal-listening-project" data-id="${escapeHtml(String(owner.revealProjectId))}" title="${title}" aria-label="${title}">${label}</button>`;
  }
  return `
                    <span class="project-listener-owner" title="${title}" aria-label="${escapeHtml(owner.announcement || owner.label)}">${label}</span>`;
}

function projectServicesDetailHtml(project, projectName) {
  const projectId = escapeHtml(String(project.id));
  return `
    <section class="service-detail-list" aria-label="Services for ${projectName}">
      ${(project.services || []).map((service) => {
        const port = String(service.port);
        const panelId = `service-detail-${projectId}-${escapeHtml(port)}`;
        const expanded = String(expandedServiceState[project.id] || '') === port;
        const details = serviceDisplayDetails(project, service);
        const address = serviceLocalAddress(service, project);
        const savedPort = service.savedPort || service.port;
        const temporaryDetail = service.temporaryPort
          ? `Temporary for this launch. Saved as port ${savedPort} via ${service.portVariable}.`
          : '';
        return `
          <div class="service-detail-item">
            <button class="service-detail-toggle" data-action="toggle-service-detail" data-id="${projectId}" data-port="${escapeHtml(port)}" aria-expanded="${expanded}" aria-controls="${panelId}">
              <span class="service-indicator ${details.indicator}" aria-hidden="true"></span>
              <span class="service-detail-name">${escapeHtml(service.name)}</span>
              <span class="service-detail-port">:${escapeHtml(port)}</span>
              <span class="service-detail-state">${details.state}</span>
              ${icon('chevron-down')}
            </button>
            ${expanded ? `<div id="${panelId}" class="service-detail-body" role="region" aria-label="Controls for ${escapeHtml(service.name)}">
              <code title="${escapeHtml(address.fullUrl)}">${escapeHtml(address.fullUrl)}</code>
              ${temporaryDetail ? `<p>${escapeHtml(temporaryDetail)}</p>` : ''}
              <div class="service-detail-actions">
                <button data-action="open-service-url" data-id="${projectId}" data-port="${escapeHtml(port)}" ${details.canUseUrl ? '' : 'disabled'}>${icon('external')}<span>Open</span></button>
                <button data-action="copy-service-url" data-id="${projectId}" data-port="${escapeHtml(port)}" ${details.canUseUrl ? '' : 'disabled'}>${icon('copy')}<span>Copy URL</span></button>
                ${details.canResolve ? `<button data-action="resolve-service-port" data-id="${projectId}" data-port="${escapeHtml(String(savedPort))}">${icon('refresh')}<span>Resolve port</span></button>` : ''}
              </div>
            </div>` : ''}
          </div>`;
      }).join('')}
    </section>`;
}

function projectDetailTabsHtml(project, projectName) {
  if (!project.detailsExpanded) {
    return '';
  }
  const projectId = escapeHtml(String(project.id));
  const tabs = project.detailTabs || ['overview'];
  const selectedTab = selectedProjectDetailTab(project);
  const tabButtons = tabs.map((tab) => {
    const label = DETAIL_TAB_LABELS[tab];
    return `<button id="detail-tab-${projectId}-${tab}" class="project-detail-tab" role="tab" data-action="select-detail-tab" data-id="${projectId}" data-tab="${tab}" aria-selected="${tab === selectedTab}" aria-controls="detail-panel-${projectId}-${tab}" tabindex="${tab === selectedTab ? '0' : '-1'}">${label}</button>`;
  }).join('');
  const runtime = project.previewExpanded ? `
    <section class="project-runtime" aria-label="Runtime for ${projectName}">
      <h3>Runtime</h3>
      <div class="resource-metrics" data-resource-metrics data-project-id="${projectId}" role="group" aria-label="${escapeHtml(resourceMetricsLabel(project.resourceMetrics, project.httpResponsePulse))}">
        ${resourceMetricsContent(project.resourceMetrics, project.runtimePulse, project.httpResponsePulse)}
      </div>
    </section>` : '';
  const overviewContent = `${readinessDetailsHtml(project, project.status || 'stopped')}${project.timeline ? projectTimelineHtml(project, projectName) : ''}${runtime}`
    || '<p class="project-detail-empty">No startup details yet.</p>';
  const outputContent = project.outputPeek !== undefined
    ? `<div class="project-output-peek-slot" data-output-peek-slot data-project-id="${projectId}" data-project-name="${projectName}">${projectOutputPeekHtml(project.outputPeek, project.id, project.name)}</div>`
    : '';
  const phoneHandoffOpen = Boolean(project.phoneHandoff && phoneHandoffState[project.id]);
  const phoneHandoffContent = project.phoneHandoff ? `
      <div class="preview-help-row">
        <p class="preview-help">If the app blocks this view, use Open in browser.</p>
        <button class="phone-handoff-toggle" data-action="toggle-phone-handoff" data-id="${projectId}" aria-expanded="${phoneHandoffOpen}" aria-controls="phone-handoff-${projectId}">${phoneHandoffOpen ? 'Hide phone code' : 'Open on phone'}</button>
      </div>
      <section id="phone-handoff-${projectId}" class="phone-handoff" tabindex="-1" aria-label="Open ${projectName} on your phone" ${phoneHandoffOpen ? '' : 'hidden'}>
        <div class="phone-handoff-code">${project.phoneHandoff.qrSvg}</div>
        <div class="phone-handoff-copy">
          <strong>Open on your phone</strong>
          <p>Scan while your phone is on the same network.</p>
          <code>${escapeHtml(project.phoneHandoff.url)}</code>
          <button data-action="copy-phone-url" data-id="${projectId}" data-url="${escapeHtml(project.phoneHandoff.url)}">Copy phone URL</button>
        </div>
      </section>` : '<p class="preview-help">If the app blocks this view, use Open in browser.</p>';
  const previewContent = project.previewExpanded ? `
    <section class="project-preview" aria-label="Preview of ${projectName}">
      <header class="preview-toolbar">
        <span>Live app</span>
        <div class="preview-actions">
          <button data-action="refresh-preview" data-id="${projectId}" aria-label="Refresh ${projectName} preview" title="Refresh preview">${icon('refresh')}</button>
          <button data-action="copy-service-url" data-id="${projectId}" data-port="${escapeHtml(String(project.previewPort))}" aria-label="Copy ${projectName} URL" title="Copy URL">${icon('copy')}</button>
          <button data-action="open" data-id="${projectId}" aria-label="Open ${projectName} in browser" title="Open in browser">${icon('external')}</button>
        </div>
      </header>
      <div class="preview-frame-wrap">
        <iframe class="preview-frame" data-preview-frame data-src="${escapeHtml(project.previewUrl)}" data-preview-incarnation="${escapeHtml(String(projectIncarnations.get(String(project.id)) || ''))}" title="${projectName} app preview" sandbox="allow-forms allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
        <div class="preview-loading" data-preview-loading role="status">Loading preview…</div>
        <div class="preview-fallback" data-preview-fallback hidden>
          <strong>Preview unavailable</strong>
          <span>This app may block embedded views.</span>
          ${project.previewUrl ? `<button class="preview-fallback-open" data-action="open" data-id="${projectId}" aria-label="Open ${projectName} in browser" title="Open in browser">${icon('external')}${autoScrollHtml('<span>Open in browser</span>')}</button>` : ''}
        </div>
      </div>
      ${phoneHandoffContent}
    </section>` : '';
  const historyContent = project.startupHistory?.length
    ? startupHistoryHtml(project, projectName)
    : '<p class="project-detail-empty">No completed starts yet.</p>';
  const panels = {
    overview: overviewContent,
    services: projectServicesDetailHtml(project, projectName),
    output: outputContent,
    preview: previewContent,
    history: historyContent
  };
  return `
    <div class="project-detail-workspace">
      <div class="project-detail-tabs" role="tablist" aria-label="Details for ${projectName}">${tabButtons}</div>
      <div class="project-detail-viewport">
        ${tabs.map((tab) => `<section id="detail-panel-${projectId}-${tab}" class="project-detail-panel" role="tabpanel" aria-labelledby="detail-tab-${projectId}-${tab}" data-detail-panel="${tab}" tabindex="0" ${tab === selectedTab ? '' : 'hidden'}>${panels[tab]}</section>`).join('')}
      </div>
    </div>`;
}

function projectNeedsAttention(project) {
  if (!project || project.status === 'unsupported') {
    return false;
  }
  if (project.reviewRequired) {
    return true;
  }
  if (['port-in-use', 'port-in-use-unknown', 'not-responding'].includes(project.status)) {
    return true;
  }
  if (project.status === 'not-ready') {
    return true;
  }
  if (project.status === 'active' && project.httpUnresponsive) {
    return true;
  }
  if (projectCanRelinkFolder(project)) {
    return true;
  }
  if (projectPrimaryAction(project).action === 'add-stop-command') {
    return true;
  }
  return Boolean(projectStartFailureText(project) || projectStopFailureText(project));
}

function attentionProjectSignature(projects) {
  return (projects || [])
    .filter((project) => projectNeedsAttention(project))
    .map((project) => String(project.id))
    .join('\n');
}

function syncAttentionFocusState(projects) {
  const signature = attentionProjectSignature(projects);
  if (signature === attentionFocusSignature) {
    return false;
  }
  attentionFocusSignature = signature;
  lastAttentionFocusId = '';
  return true;
}

function visibleAttentionProjects(projects) {
  return (projects || []).filter((project) => {
    if (!projectNeedsAttention(project)) {
      return false;
    }
    const row = document.querySelector(`.project-row[data-project-id="${CSS.escape(String(project.id))}"]`);
    return row && row.hidden !== true;
  });
}

function announceAttentionFocus(project) {
  const status = document.getElementById('attention-focus-status');
  if (status && project?.name) {
    status.textContent = `Focused ${project.name}.`;
  }
}

function focusAttentionProject(project) {
  if (!project) {
    return;
  }
  const projectId = String(project.id);
  const row = document.querySelector(`.project-row[data-project-id="${CSS.escape(projectId)}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  const control = document.querySelector(`.run-button[data-id="${CSS.escape(projectId)}"]`);
  control?.focus();
  announceAttentionFocus(project);
}

function handleClearFiltersForAttention() {
  clearProjectFilters();
  requestAnimationFrame(() => {
    focusNextAttentionProject();
  });
}

function focusNextAttentionProject() {
  syncAttentionFocusState(state.projects);
  const visible = visibleAttentionProjects(state.projects);
  if (!visible.length) {
    const hiddenCount = (state.projects || [])
      .filter((project) => projectNeedsAttention(project)).length;
    if (hiddenCount > 0) {
      const status = document.getElementById('project-search-status');
      if (status) {
        status.textContent = 'Some projects that need attention are hidden by your filters.';
      }
    }
    return;
  }
  const visibleIds = visible.map((project) => String(project.id));
  let nextIndex = 0;
  if (lastAttentionFocusId && visibleIds.includes(lastAttentionFocusId)) {
    const currentIndex = visibleIds.indexOf(lastAttentionFocusId);
    nextIndex = (currentIndex + 1) % visibleIds.length;
  }
  const project = visible[nextIndex];
  lastAttentionFocusId = String(project.id);
  saveWebviewState();
  focusAttentionProject(project);
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
  const ownershipLostCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'ownership-lost').length;
  const stoppedCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'stopped').length;
  const conflictCount = projects
    .filter((project) => !project.reviewRequired
      && ['port-in-use', 'port-in-use-unknown'].includes(project.status)).length;
  const unsupportedCount = projects.filter((project) => project.status === 'unsupported').length;
  return `<span class="status-dot ${runningCount ? 'running' : ''}"></span>${runningCount} running${startingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${startingCount} starting` : ''}${notReadyCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${notReadyCount} taking longer` : ''}${notRespondingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${notRespondingCount} not responding` : ''}${stoppingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${stoppingCount} stopping` : ''}${ownershipLostCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${ownershipLostCount} control unavailable` : ''} <span class="summary-separator" aria-hidden="true">·</span> ${stoppedCount} stopped${reviewCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${reviewCount} to review` : ''}${conflictCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${conflictCount} unavailable` : ''}${unsupportedCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${unsupportedCount} local only` : ''}`;
}

function reviewFilterSummaryHtml(projects) {
  const reviewCount = (projects || []).filter((project) => project.reviewRequired).length;
  if (!reviewCount) {
    return '';
  }
  const label = `Review setup (${reviewCount})`;
  const pressed = reviewFilterActive ? 'true' : 'false';
  const ariaLabel = reviewFilterActive
    ? `Showing ${reviewCount} ${reviewCount === 1 ? 'project' : 'projects'} to review. Clear review filter.`
    : `Show ${reviewCount} ${reviewCount === 1 ? 'project' : 'projects'} to review`;
  return `<button type="button" class="active-review-chip" data-action="toggle-review-filter" aria-pressed="${pressed}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(label)}">${escapeHtml(label)}${reviewFilterActive ? ` ${icon('close')}` : ''}</button>`;
}

function attentionSummaryHtml(projects) {
  const attentionProjects = (projects || []).filter((project) => projectNeedsAttention(project));
  if (!attentionProjects.length) {
    return '';
  }
  const count = attentionProjects.length;
  const visibleCount = visibleAttentionProjects(projects).length;
  const hiddenCount = count - visibleCount;
  const label = count > 1 ? `Needs attention (${count})` : 'Needs attention';
  let ariaLabel;
  if (hiddenCount > 0) {
    ariaLabel = visibleCount > 0
      ? `Focus next project that needs attention, ${visibleCount} of ${count} visible, ${hiddenCount} hidden by filters`
      : `Focus project that needs attention, ${count} hidden by filters`;
  } else {
    ariaLabel = count > 1
      ? `Focus next project that needs attention, ${count} projects`
      : 'Focus project that needs attention';
  }
  const attentionButton = `<button type="button" class="summary-attention" data-action="focus-attention" aria-label="${escapeHtml(ariaLabel)}">${autoScrollHtml(escapeHtml(label))}</button>`;
  if (hiddenCount > 0) {
    const clearButton = `<button type="button" class="summary-attention-clear" data-action="clear-filters-for-attention" aria-label="Clear search, tag, group, and review filters to show projects that need attention">${escapeHtml('Clear filters')}</button>`;
    return `<div class="summary-attention-group">${attentionButton}${clearButton}</div>`;
  }
  return attentionButton;
}

function autoScrollHtml(text) {
  return `<span class="auto-scroll"><span class="auto-scroll-content">${text}</span></span>`;
}

function groupProgressHtml(group) {
  if (!group.progress) {
    return `${group.projectIds.length} project${group.projectIds.length === 1 ? '' : 's'}`;
  }
  if (group.blockingProjectId) {
    const projectName = escapeHtml(group.blockingProjectName || 'project');
    const projectId = escapeHtml(String(group.blockingProjectId));
    const focusButton = `<button type="button" class="group-blocking-focus" data-action="focus-group-blocking" data-project-id="${projectId}" aria-label="Show ${projectName}">${autoScrollHtml(projectName)}</button>`;
    return `<span class="group-progress-failure">${escapeHtml(group.progress)} ${focusButton}</span>`;
  }
  return escapeHtml(group.progress);
}

function focusGroupBlockingProject(projectId) {
  const project = state.projects.find((entry) => String(entry.id) === String(projectId));
  if (!project) {
    return;
  }
  const row = document.querySelector(`.project-row[data-project-id="${CSS.escape(String(projectId))}"]`);
  if (!row) {
    return;
  }
  if (row.hidden) {
    clearProjectFilters();
    renderList();
    requestAnimationFrame(() => {
      focusGroupBlockingProject(projectId);
    });
    return;
  }
  row.scrollIntoView({ block: 'nearest' });
  const control = document.querySelector(`.run-button[data-id="${CSS.escape(String(projectId))}"]`);
  control?.focus();
  const status = document.getElementById('project-lifecycle-status');
  if (status && project.name) {
    status.textContent = `Focused ${project.name}.`;
  }
}

function groupFilterHtml() {
  if (!state.groups?.length) {
    return '';
  }
  const activeGroup = state.groups.find((group) => String(group.id) === selectedGroupFilter);
  return `
    <section class="project-group-filter" aria-label="Run group filter">
      <div class="project-group-filter-bar">
        <button class="group-filter-toggle" data-action="toggle-group-filter" aria-expanded="${groupsExpanded}"${groupsExpanded ? ' aria-controls="project-group-choices"' : ''}>
          ${icon('chevron-down')}<span>Groups</span>
        </button>
        ${activeGroup ? `<button class="active-group-chip" data-action="select-group-filter" data-id="${escapeHtml(activeGroup.id)}" aria-label="Clear group filter ${escapeHtml(activeGroup.name)}" title="Clear group filter">${escapeHtml(activeGroup.name)} ${icon('close')}</button>` : ''}
      </div>
      ${groupsExpanded ? `<div id="project-group-choices" class="project-group-choices" role="group" aria-label="Filter projects by run group">
        <button type="button" data-action="select-group-filter" data-id="" aria-pressed="${!activeGroup}">All projects</button>
        ${state.groups.map((group) => {
          const groupId = escapeHtml(group.id);
          const groupName = escapeHtml(group.name);
          const actionLabel = group.canStop ? `Stop group ${groupName}` : `Start group ${groupName}`;
          const pressed = String(group.id) === selectedGroupFilter;
          return `
            <div class="group-choice-row">
              <button type="button" class="group-choice-name" data-action="select-group-filter" data-id="${groupId}" aria-pressed="${pressed}" title="${groupName}">
                <strong>${groupName}</strong>
                <span>${groupProgressHtml(group)}</span>
              </button>
              <div class="group-choice-actions">
                ${group.canStop
                  ? `<button type="button" data-action="stop-group" data-id="${groupId}" aria-label="Stop group ${groupName}" title="${group.lifecycleBlocked ? 'Lifecycle controls are available only for local projects' : actionLabel}" ${group.busy || group.lifecycleBlocked ? 'disabled' : ''}>${productIcon('stop')}</button>`
                  : `<button type="button" data-action="start-group" data-id="${groupId}" aria-label="Start group ${groupName}" title="${group.lifecycleBlocked ? 'Lifecycle controls are available only for local projects' : actionLabel}" ${group.busy || group.lifecycleBlocked || !group.projectIds.length ? 'disabled' : ''}>${productIcon(group.busy ? 'loading' : 'play')}</button>`}
              </div>
            </div>`;
        }).join('')}
      </div>` : ''}
    </section>`;
}

function tagFilterHtml() {
  const tags = Array.isArray(state.tags) ? state.tags : [];
  if (!tags.length) {
    return '';
  }
  const activeTag = tags.find((tag) => (
    normalizeTagIdentity(tag) === normalizeTagIdentity(selectedTagFilter)
  ));
  return `
    <section class="project-tag-filter" aria-label="Project tag filter">
      <div class="project-tag-filter-bar">
        <button class="tag-filter-toggle" data-action="toggle-tag-filter" aria-expanded="${tagsExpanded}"${tagsExpanded ? ' aria-controls="project-tag-choices"' : ''}>
          ${icon('chevron-down')}<span>Tags</span>
        </button>
        ${activeTag ? `<button class="active-tag-chip" data-action="select-tag-filter" data-tag="${escapeHtml(activeTag)}" aria-label="Clear tag filter ${escapeHtml(activeTag)}" title="Clear tag filter">${escapeHtml(activeTag)} ${icon('close')}</button>` : ''}
      </div>
      ${tagsExpanded ? `<div id="project-tag-choices" class="project-tag-choices" role="group" aria-label="Filter projects by tag">
        <button data-action="select-tag-filter" data-tag="" aria-pressed="${!activeTag}">All projects</button>
        ${tags.map((tag) => `<button data-action="select-tag-filter" data-tag="${escapeHtml(tag)}" aria-pressed="${tag === activeTag}">${escapeHtml(tag)}</button>`).join('')}
      </div>` : ''}
    </section>`;
}

function invalidateProjectPreviewLoad() {
  previewLoadGeneration += 1;
  clearTimeout(previewLoadTimer);
  previewLoadTimer = undefined;
  if (!activePreviewLoad) {
    return;
  }
  activePreviewLoad.frame.removeEventListener?.('load', activePreviewLoad.onLoad);
  activePreviewLoad.frame.removeEventListener?.('error', activePreviewLoad.onError);
  activePreviewLoad = undefined;
}

function renderList() {
  invalidateProjectPreviewLoad();
  const focusedElement = document.activeElement;
  const preserveSearchFocus = focusedElement?.id === 'project-search';
  const restoreInitialSearchFocus = firstListRender && searchFocused && !preserveSearchFocus;
  const capturedSelectionStart = preserveSearchFocus
    && Number.isInteger(focusedElement.selectionStart)
    ? focusedElement.selectionStart
    : undefined;
  const capturedSelectionEnd = preserveSearchFocus
    && Number.isInteger(focusedElement.selectionEnd)
    ? focusedElement.selectionEnd
    : undefined;
  let webviewStateChanged = reconcilePerItemWebviewState(state.projects);
  for (const project of state.projects) {
    if (!project.detailsExpanded && detailTabState[project.id]) {
      delete detailTabState[project.id];
      webviewStateChanged = true;
    }
    if ((!project.previewExpanded || !project.phoneHandoff) && phoneHandoffState[project.id]) {
      delete phoneHandoffState[project.id];
      webviewStateChanged = true;
    }
    const selectedFailureKey = startupFailureState[project.id];
    if (selectedFailureKey && (!project.detailsExpanded || !project.startupHistory?.some((entry, index) => (
      entry.failureSummary && startupHistoryEntryKey(entry, index) === selectedFailureKey
    )))) {
      delete startupFailureState[project.id];
      webviewStateChanged = true;
    }
  }
  if (syncAttentionFocusState(state.projects)) {
    webviewStateChanged = true;
  }
  const reviewCount = state.projects.filter((project) => project.reviewRequired).length;
  if (!reviewCount && reviewFilterActive) {
    reviewFilterActive = false;
    webviewStateChanged = true;
  }
  if (webviewStateChanged) {
    saveWebviewState();
  }
  const availableTags = Array.isArray(state.tags) ? state.tags : [];
  if (selectedTagFilter && !availableTags.some((tag) => (
    normalizeTagIdentity(tag) === normalizeTagIdentity(selectedTagFilter)
  ))) {
    selectedTagFilter = '';
    state.tagFilter = '';
    saveWebviewState();
  }
  if (selectedGroupFilter && !(state.groups || []).some((group) => String(group.id) === selectedGroupFilter)) {
    selectedGroupFilter = '';
    saveWebviewState();
  }
  if (state.projects.length === 0) {
    const workspaceFolder = String(state.currentWorkspaceFolder || '');
    const workspaceFolderName = String(state.currentWorkspaceFolderName || '')
      || (workspaceFolder ? workspaceFolder.split(/[/\\]/).filter(Boolean).at(-1) || workspaceFolder : '');
    const workspaceFolders = Array.isArray(state.workspaceFolders) ? state.workspaceFolders : [];
    const addLabel = 'Add this folder';
    const emptyCopy = workspaceFolder
      ? `Add ${workspaceFolderName || 'the folder'} open in this window.`
      : workspaceFolders.length > 1
        ? 'Choose a folder open in this window.'
        : 'Open a folder in this window first.';
    const startScripts = Array.isArray(state.workspaceStartScripts)
      ? state.workspaceStartScripts.filter((script) => script
        && ['start', 'dev'].includes(script.name)
        && typeof script.startCommand === 'string')
      : [];
    const stackPending = state.stackContractPending === true;
    app.innerHTML = `
      ${groupFilterHtml()}
      <section class="empty-state">
        <h2>No projects yet</h2>
        <p>${escapeHtml(emptyCopy)}</p>
        ${workspaceFolderName ? `<p class="empty-folder" title="${escapeHtml(workspaceFolder)}">${escapeHtml(workspaceFolderName)}</p>` : ''}
        ${!workspaceFolder && workspaceFolders.length > 1 ? `
          <div class="empty-workspace-choices" role="group" aria-label="Workspace folders in this window">
            ${workspaceFolders.map((entry) => `
              <button type="button" class="secondary-button empty-workspace-choice" data-action="select-workspace-folder" data-folder="${escapeHtml(entry.folder)}" title="${escapeHtml(entry.folder)}">
                ${escapeHtml(entry.name || entry.folder)}
              </button>`).join('')}
          </div>` : ''}
        ${state.lifecycleWindowSupported === false ? `<p>Start and Stop work for apps on this computer. You can still save projects here. Remote SSH, Dev Containers, GitHub Codespaces, VS Code Tunnels, and Windows WSL network paths will not start or stop processes in this release.</p>` : ''}
        <div class="empty-actions">
          ${workspaceFolder ? `<button class="primary-button" data-action="show-add">${addLabel}</button>` : ''}
          ${stackPending ? `<button class="secondary-button" data-action="load-workspace-stack">Load stack</button>` : ''}
          ${workspaceFolder && startScripts.length ? `
            <div class="empty-start-chips" role="group" aria-label="Start options for this folder">
              ${startScripts.map((script) => {
                const chipLabel = script.name === 'dev' ? 'Dev' : 'Start';
                const chipHint = `Save and start \`${script.startCommand}\` for this folder`;
                return `
                <button class="empty-start-chip" data-action="start-workspace-script" data-script="${escapeHtml(script.name)}" title="${escapeHtml(chipHint)}" aria-label="${escapeHtml(chipHint)}">
                  ${escapeHtml(chipLabel)}
                </button>`;
              }).join('')}
            </div>` : ''}
        </div>
      </section>`;
    firstListRender = false;
    return;
  }

  const runningAppIds = new Set((state.runningAppIds || []).map(String));
  const runningApps = state.projects.filter((project) => runningAppIds.has(String(project.id)));

  app.innerHTML = `
    <header class="summary" aria-label="Project status summary">
      <span id="project-count"><strong>${state.projects.length}</strong> ${state.projects.length === 1 ? 'project' : 'projects'}</span>
      <span class="summary-trailing">
        <span id="summary-status" class="summary-status">${statusSummaryHtml(state.projects)}</span>
        ${state.stopAllCount > 1 ? `
          <button class="stop-all-button" data-action="stop-all" aria-label="Stop all ${state.stopAllCount} running projects">
            ${productIcon('stop', 'bulk-stop-icon')}
            Stop all (${state.stopAllCount})
          </button>` : ''}
      </span>
    </header>
    <div id="summary-attention-slot" class="summary-attention-slot">${reviewFilterSummaryHtml(state.projects)}${attentionSummaryHtml(state.projects)}</div>
    <span id="attention-focus-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></span>
    <span id="project-lifecycle-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></span>
    ${state.routeNotice ? `
      <section id="route-notice" class="diagnosis-notice" role="status" aria-live="polite" aria-atomic="true">
        <strong>Diagnosis closed</strong>
        <p>${escapeHtml(state.routeNotice)}</p>
      </section>` : ''}
    ${state.lifecycleWindowSupported === false ? `
      <section class="diagnosis-notice" role="status" aria-live="polite">
        <p>Start and Stop work for apps on this computer. Remote SSH, Dev Containers, GitHub Codespaces, VS Code Tunnels, and Windows WSL network paths can save and list projects only.</p>
      </section>` : ''}
    ${state.composeNotice ? `
      <section class="diagnosis-notice" role="status" aria-live="polite" aria-label="Compose availability">
        <p>${escapeHtml(state.composeNotice)}</p>
      </section>` : ''}
    ${groupFilterHtml()}
    ${state.projects.length > 1 ? `
    <div class="project-search">
      ${icon('search', 'search-icon')}
      <input id="project-search" type="search" value="${escapeHtml(searchQuery)}" placeholder="Search projects" aria-label="Search projects" autocomplete="off" spellcheck="false">
    </div>` : ''}
    ${tagFilterHtml()}
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
        const conflictOwnerName = conflict?.ownerName || 'Another app';
        const escapedConflictOwnerName = escapeHtml(conflictOwnerName);
        const conflictProjectNames = (conflict?.projectNames || []).map(escapeHtml).join(', ');
        const conflicted = ['port-in-use', 'port-in-use-unknown'].includes(projectStatus);
        const primaryAction = projectPrimaryAction(project);
        const actionTitle = escapeHtml(primaryAction.label);
        const transitioning = project.forceClosing
          || project.handoffInProgress
          || ['starting', 'not-ready', 'stopping'].includes(projectStatus);
        const canOpen = Boolean(project.previewUrl);
        const canOpenOnPhone = Boolean(project.phoneHandoff);
        const detectedWithoutStop = projectStatus === 'active' && !project.stopCommand;
        const ownershipLostWithoutStop = projectStatus === 'ownership-lost' && !project.stopCommand;
        const stopState = ['running', 'starting', 'not-ready', 'not-responding', 'ownership-lost', 'active'].includes(projectStatus);
        const canRestart = !reviewRequired
          && project.folderAccessible !== false
          && ['running', 'not-ready', 'not-responding', 'ownership-lost', 'active'].includes(projectStatus)
          && !detectedWithoutStop
          && !ownershipLostWithoutStop;
        const canCloseConfiguredPorts = !reviewRequired
          && Boolean(project.openPorts?.length)
          && !project.forceClosing
          && !project.handoffInProgress
          && projectStatus !== 'stopping';
        const blocked = conflicted || project.lifecycleBlocked;
        const showAddStopCommand = !reviewRequired
          && ((detectedWithoutStop || ownershipLostWithoutStop) && !project.stopFailure);
        const showCopyError = !transitioning
          && !project.handoffInProgress
          && ((!reviewRequired
            && projectStatus === 'stopped'
            && project.failureSummary)
          || (Boolean(project.stopFailure)
            && projectStatus !== 'stopped'
            && projectStatus !== 'stopping'));
        const primaryButtonClass = reviewRequired
          || primaryAction.action === 'edit'
          || primaryAction.action === 'add-stop-command'
          || primaryAction.action === 'fix-environment'
          ? 'review'
          : primaryAction.action === 'relink-folder'
            ? 'relink'
            : blocked
              ? 'blocked'
              : primaryAction.mode;
        const launchProfiles = project.launchProfiles || [];
        const hasLaunchProfiles = launchProfiles.length > 1;
        const launchProfileMenuId = `profile:${projectId}`;
        const projectActionMenuId = `actions:${projectId}`;
        const launchProfileDisabledReason = project.launchProfileChangeDisabled
          ? 'Stop this project to change profile.'
          : '';
        const openTitle = canOpen
          ? `Open ${projectName} in your browser`
          : conflicted
            ? 'This port may belong to another app'
            : stopState
              ? `${projectName} does not have a responding web service yet`
              : `Start ${projectName} before opening it`;
        const openOnPhoneTitle = canOpenOnPhone
          ? `Open ${projectName} on your phone`
          : canOpen
            ? `Phone sharing needs one private LAN address and a localhost preview for ${projectName}`
            : openTitle;
        const statusTitle = project.lifecycleBlocked
          ? project.lifecycleBlockedReason
          : reviewRequired
          ? 'A coding agent added or updated this setup. Review its folder and commands before running it.'
          : projectStatus === 'active'
          ? project.httpUnresponsive
            ? 'The configured port is open, but the web service did not respond. Runlist did not start this process.'
            : project.stopCommand
              ? 'Detected through a configured service port; Runlist did not start this process.'
              : 'Runlist detected this app on a configured port but did not start it.'
          : projectStatus === 'not-responding'
            ? 'The launched process is still running and its configured port is open, but the web service did not respond.'
          : projectStatus === 'not-ready'
            ? 'The launched process is still running. Runlist is continuing to check its configured services.'
          : projectStatus === 'ownership-lost'
            ? project.stopCommand
              ? 'The launching VS Code window is unavailable. Runlist can use your custom stop command.'
              : 'The launching VS Code window is unavailable. Runlist will not stop an unverified process.'
          : projectStatus === 'port-in-use-unknown'
            ? `Port :${conflict?.port || 'unknown'} is shared with ${conflictProjectNames}. Runlist cannot identify the running owner.`
            : projectStatus === 'port-in-use'
              ? `${escapedConflictOwnerName} is using port :${conflict?.port || 'unknown'}.`
              : project.failureSummary?.kind === 'missing-required-env'
                ? 'Add the missing environment variables, then try Start again.'
                : '';
        const readinessRowText = projectRowReadinessStatusText(project);
        const displayedStatus = readinessRowText || projectDisplayedStatus(project);
        const startFailureText = projectStartFailureText(project);
        const stopFailureText = projectStopFailureText(project);
        const folderMissing = projectShowsMissingFolder(project);
        const rowStatusTitle = (readinessRowText ? escapeHtml(projectStatusDetailText(project)) : '')
          || statusTitle
          || (folderMissing ? 'The saved folder is missing or cannot be opened.' : '')
          || (startFailureText ? escapeHtml(startFailureText) : '')
          || (stopFailureText ? escapeHtml(stopFailureText) : '');
        const statusDotClass = folderMissing || startFailureText || stopFailureText
          ? 'conflict'
          : ['running', 'active'].includes(statusClass)
          && !(projectStatus === 'active' && project.httpUnresponsive)
          ? 'running'
          : ['port-in-use', 'port-in-use-unknown', 'not-ready', 'not-responding', 'review-required', 'ownership-lost'].includes(statusClass)
            ? 'conflict'
            : '';
        const rowStatusClass = folderMissing
          ? 'folder-missing'
          : startFailureText
          ? 'start-failed'
          : stopFailureText
            ? 'stop-failed'
            : statusClass;
        const rowPort = projectRowPort(project);
        const portLabel = rowPort ? `:${rowPort}` : '';
        const rowElapsedStartedAt = projectRowElapsedStartedAt(project);
        const rowElapsedLabel = Number.isFinite(rowElapsedStartedAt)
          ? formatElapsed(Date.now() - rowElapsedStartedAt)
          : '';
        const isComposeProject = typeof project.composePath === 'string' && Boolean(project.composePath.trim());
        const projectKindLabel = isComposeProject ? 'Compose project' : 'project';
        const titleAriaLabel = project.pinned
          ? `Pinned ${projectKindLabel}: ${projectName}${project.currentWorkspace ? ', this window' : ''}`
          : `${isComposeProject ? `${projectKindLabel}: ` : ''}${projectName}${project.currentWorkspace ? ', this window' : ''}`;
        return `
          <article id="project-row-${projectId}" class="project-row${isComposeProject ? ' compose-project-row' : ''}" data-project-id="${projectId}"${isComposeProject ? ' data-compose="true"' : ''} aria-labelledby="project-${projectId}" aria-describedby="project-folder-${projectId}" tabindex="-1" title="${escapeHtml(project.folder)}">
            <div class="project-topline">
              <div class="project-heading">
                <div class="project-title-line">
                  <h2 id="project-${projectId}" title="${project.pinned ? `Pinned: ${projectName}` : projectName}" aria-label="${titleAriaLabel}">
                    ${project.pinned ? icon('pinned', 'project-kind-icon pinned-icon') : ''}
                    ${isComposeProject ? `<span class="compose-kind-marker" title="Compose project">${icon('layers', 'project-kind-icon compose-kind-icon')}</span>` : ''}
                    ${projectName}
                  </h2>
                </div>
                <div class="project-meta">
                  <div class="project-status status-${rowStatusClass}"${rowStatusTitle ? ` title="${rowStatusTitle}"` : ''}>${!reviewRequired && transitioning ? productIcon('loading', 'status-progress') : `<span class="status-dot ${statusDotClass}" aria-hidden="true"></span>`}${autoScrollHtml(`<span>${escapeHtml(displayedStatus)}</span>`)}</div>
                  ${Number.isFinite(rowElapsedStartedAt) ? `
                    <span class="project-row-elapsed" data-row-elapsed data-started-at="${rowElapsedStartedAt}" aria-label="Running for ${escapeHtml(rowElapsedLabel)}">${escapeHtml(rowElapsedLabel)}</span>` : ''}
                  ${rowPort ? `
                    <button class="project-port-chip${canOpen ? ' is-openable' : ''}" data-action="open" data-id="${projectId}" ${canOpen ? '' : 'disabled'} title="${openTitle}" aria-label="${canOpen ? `Open ${projectName} at ${escapeHtml(project.previewUrl || `localhost${portLabel}`)}` : openTitle}">
                      <span class="project-port-label">${escapeHtml(portLabel)}</span>${canOpen ? '<span class="project-open-label">Open</span>' : ''}
                    </button>` : ''}
                  ${project.services?.length ? `
                    <button class="preview-toggle" data-action="open-services" data-id="${projectId}" aria-expanded="${project.detailsExpanded}" aria-controls="details-${projectId}" aria-label="${project.detailsExpanded ? 'Collapse' : 'Expand'} services for ${projectName}" title="${project.detailsExpanded ? 'Collapse' : 'Expand'} services">${icon('chevron-down')}</button>` : ''}
                  ${!project.services?.length && project.startupHistory?.length ? `
                    <button class="preview-toggle" data-action="toggle-preview" data-id="${projectId}" aria-label="${project.detailsExpanded ? 'Collapse' : 'Expand'} project details for ${projectName}" aria-expanded="${project.detailsExpanded}" aria-controls="details-${projectId}" title="${project.detailsExpanded ? 'Collapse' : 'Expand'} project details">${icon('chevron-down')}</button>` : ''}
                </div>
                <span id="project-folder-${projectId}" class="visually-hidden">${escapeHtml(project.folder)}${isComposeProject ? `. Compose file ${escapeHtml(project.composePath)}` : ''}</span>
              </div>
              <div class="project-actions">
                ${hasLaunchProfiles ? `
                  <div class="launch-profile-picker">
                    <button class="launch-profile-trigger menu-trigger" data-action="toggle-profile-menu" data-id="${projectId}" data-menu-target="${launchProfileMenuId}" aria-label="Launch profile: ${escapeHtml(project.activeLaunchProfileName)}" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(launchProfileDisabledReason || `Launch profile: ${project.activeLaunchProfileName}`)}" ${project.launchProfileChangeDisabled ? 'disabled' : ''}>
                      <span>${escapeHtml(project.activeLaunchProfileName)}</span>${icon('chevron-down')}
                    </button>
                    <div class="action-menu launch-profile-menu" data-menu-id="${launchProfileMenuId}" role="menu" aria-label="Launch profile for ${projectName}" hidden>
                      ${launchProfiles.map((profile) => `<button data-action="select-launch-profile" data-id="${projectId}" data-profile-id="${escapeHtml(profile.id)}" role="menuitemradio" aria-checked="${profile.id === project.activeLaunchProfileId}"><span class="profile-check" aria-hidden="true">${profile.id === project.activeLaunchProfileId ? '✓' : ''}</span><span>${escapeHtml(profile.name)}</span></button>`).join('')}
                    </div>
                  </div>` : ''}
                <button class="run-button ${primaryButtonClass}" data-action="${primaryAction.action}" data-id="${projectId}"${primaryAction.action === 'fix-environment' ? ' data-focus-target="env-map"' : ''} aria-label="${actionTitle}" title="${actionTitle}" ${primaryAction.disabled ? 'disabled' : ''}>
                  ${primaryAction.action === 'edit'
                    || primaryAction.action === 'add-stop-command'
                    || primaryAction.action === 'fix-environment'
                    ? icon('edit')
                    : primaryAction.action === 'relink-folder'
                      ? icon('folder')
                      : primaryAction.action === 'show-terminal'
                        ? icon('terminal')
                        : productIcon(primaryAction.mode === 'stop' ? 'stop' : 'play')}
                </button>
                ${canRestart ? `
                <button class="run-button restart" data-action="restart" data-id="${projectId}" aria-label="Restart ${projectName}" title="Restart ${projectName}" ${transitioning ? 'disabled' : ''}>
                  ${icon('refresh')}
                </button>` : ''}
                <button class="more-button menu-trigger" data-action="toggle-menu" data-id="${projectId}" data-menu-target="${projectActionMenuId}" aria-label="More actions for ${projectName}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
                <div class="action-menu" data-menu-id="${projectActionMenuId}" role="menu" aria-label="Actions for ${projectName}" hidden>
                  <button data-action="open" data-id="${projectId}" role="menuitem" ${canOpen ? '' : 'disabled'} title="${openTitle}">
                    ${icon('external', 'menu-icon')}<span>Open app</span>
                  </button>
                  <button data-action="open-on-phone" data-id="${projectId}" role="menuitem" ${canOpenOnPhone ? '' : 'disabled'} title="${openOnPhoneTitle}">
                    ${icon('external', 'menu-icon')}<span>Open on phone</span>
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
                  ${showCopyError ? `
                  <button data-action="copy-error" data-id="${projectId}" role="menuitem" aria-label="Copy ${project.stopFailure && projectStatus !== 'stopped' ? 'stop' : 'start'} error for ${projectName}" title="Copy the latest error for ${projectName}">
                    ${icon('copy', 'menu-icon')}<span>Copy error</span>
                  </button>` : ''}
                  <button data-action="show-terminal" data-id="${projectId}" role="menuitem">
                    ${icon('terminal', 'menu-icon')}<span>Show terminal</span>
                  </button>
                  ${primaryAction.action === 'show-terminal' && stopState && projectStatus !== 'not-ready' && !detectedWithoutStop && !ownershipLostWithoutStop ? `
                  <button data-action="stop" data-id="${projectId}" role="menuitem" aria-label="Stop ${projectName}" title="Stop ${projectName}" ${primaryAction.disabled || blocked ? 'disabled' : ''}>
                    ${productIcon('stop', 'menu-icon')}<span>Stop</span>
                  </button>` : ''}
                  ${primaryAction.action === 'show-terminal' && !stopState ? `
                  <button data-action="start" data-id="${projectId}" role="menuitem" aria-label="Start ${projectName}" title="Start ${projectName}" ${primaryAction.disabled || blocked ? 'disabled' : ''}>
                    ${productIcon('play', 'menu-icon')}<span>Start</span>
                  </button>` : ''}
                  <button data-action="restart" data-id="${projectId}" role="menuitem" aria-label="Restart ${projectName}" ${canRestart ? '' : 'disabled'}>
                    ${icon('refresh', 'menu-icon')}<span>Restart</span>
                  </button>
                  ${showAddStopCommand ? `
                  <button data-action="add-stop-command" data-id="${projectId}" role="menuitem" aria-label="Add a stop command for ${projectName}">
                    ${icon('edit', 'menu-icon')}<span>Add stop command</span>
                  </button>` : ''}
                  <button data-action="force-close-ports" data-id="${projectId}" role="menuitem" aria-label="Close configured ports for ${projectName}" ${canCloseConfiguredPorts && !project.lifecycleBlocked ? '' : 'disabled'} title="${project.lifecycleBlocked ? escapeHtml(project.lifecycleBlockedReason) : canCloseConfiguredPorts ? `Review and close the processes using ${projectName}'s configured ports` : 'No configured ports are currently open'}">
                    ${icon('stop', 'menu-icon')}<span>Close configured ports…</span>
                  </button>
                  <button data-action="import-compose" data-id="${projectId}" role="menuitem" title="Review Compose services for ${projectName}">
                    ${icon('layers', 'menu-icon')}<span>Import Compose services…</span>
                  </button>
                  ${projectCanRelinkFolder(project) ? `
                  <button data-action="relink-folder" data-id="${projectId}" role="menuitem" title="Choose a new folder for ${projectName}" aria-label="Choose a new folder for ${projectName}">
                    ${icon('folder', 'menu-icon')}<span>Choose folder</span>
                  </button>` : ''}
                  ${reviewRequired && project.failureSummary?.kind === 'missing-required-env' ? `
                  <button data-action="fix-environment" data-id="${projectId}" data-focus-target="env-map" role="menuitem" aria-label="Fix environment setup for ${projectName}">
                    ${icon('edit', 'menu-icon')}<span>Fix environment</span>
                  </button>` : ''}
                  <button data-action="edit" data-id="${projectId}" role="menuitem">
                    ${icon('edit', 'menu-icon')}<span>${reviewRequired ? 'Review setup' : 'Edit project'}</span>
                  </button>
                  <button data-action="toggle-pin" data-id="${projectId}" role="menuitem" aria-label="${project.pinned ? `Unpin ${projectName}` : `Pin ${projectName} to the top`}">
                    ${icon(project.pinned ? 'pinned' : 'pin', 'menu-icon')}<span>${project.pinned ? 'Unpin' : 'Pin to top'}</span>
                  </button>
                  ${project.currentWorkspace ? `<button role="menuitem" disabled>
                    ${icon('folder', 'menu-icon')}<span>This window</span>
                  </button>` : ''}
                  <div class="menu-divider" role="separator"></div>
                  <button class="danger" data-action="delete" data-id="${projectId}" role="menuitem">
                    ${icon('trash', 'menu-icon')}<span>Delete project</span>
                  </button>
                </div>
              </div>
            </div>
            ${(project.services?.length || project.timeline || project.previewUrl || project.startupHistory?.length) ? `<div id="details-${projectId}" class="project-live-details" ${project.detailsExpanded ? '' : 'hidden'}>${projectDetailTabsHtml(project, projectName)}</div>` : ''}
          </article>`;
      }).join('')}
      <div class="search-empty" data-search-empty hidden>
        <h2>No matching projects</h2>
        <p>Try a different search or clear your filters.</p>
        <button type="button" class="primary-button" data-action="clear-filters" aria-label="Clear search, tag, group, and review filters">Clear filters</button>
      </div>
    </section>`;

  applyProjectFilter(searchQuery);
  announceProjectStatusChanges(state.projects);
  const searchInput = document.getElementById('project-search');
  searchInput?.addEventListener('input', handleSearchInput);
  if ((preserveSearchFocus || restoreInitialSearchFocus) && searchInput) {
    searchInput.focus();
    const selectionStart = preserveSearchFocus && capturedSelectionStart !== undefined
      ? capturedSelectionStart
      : searchSelectionStart;
    const selectionEnd = preserveSearchFocus && capturedSelectionEnd !== undefined
      ? capturedSelectionEnd
      : searchSelectionEnd;
    searchInput.setSelectionRange?.(selectionStart, selectionEnd);
  }
  firstListRender = false;
  scheduleAutoScrollUpdate();
  scheduleRunningAppNavigatorUpdate();
  initializeProjectPreview();
  initializeTimelineClock();
  requestProjectOutputPeeks();
}

function requestProjectOutputPeeks() {
  for (const project of state.projects || []) {
    if (project.outputPeek === undefined) {
      continue;
    }
    const id = String(project.id);
    const projectIncarnation = projectIncarnations.get(id);
    if (!projectIncarnation) {
      continue;
    }
    vscode.postMessage({
      type: 'showOutput',
      id,
      projectIncarnation
    });
  }
}

function announceProjectStatusChanges(projects) {
  const next = new Map((projects || []).map((project) => [
    String(project.id),
    projectStatusAnnouncement(project)
  ]));
  const nextFolderAccess = new Map((projects || []).map((project) => [
    String(project.id),
    project.folderAccessible !== false
  ]));
  if (announcedProjectStatuses.size || announcedFolderAccess.size) {
    const folderChanges = [];
    const folderChangedIds = new Set();
    for (const project of projects || []) {
      const id = String(project.id);
      const wasAccessible = announcedFolderAccess.get(id);
      const isAccessible = project.folderAccessible !== false;
      if (wasAccessible === true && isAccessible === false) {
        folderChanges.push(`Folder missing for ${project.name}`);
        folderChangedIds.add(id);
      } else if (wasAccessible === false && isAccessible === true) {
        folderChanges.push(`${project.name} folder updated`);
        folderChangedIds.add(id);
      }
    }
    const statusChanges = [...next]
      .filter(([id, label]) => announcedProjectStatuses.get(id) !== label && !folderChangedIds.has(id))
      .map(([, label]) => label);
    const changes = [...folderChanges, ...statusChanges];
    const status = document.getElementById('project-lifecycle-status');
    if (status && changes.length) {
      status.textContent = changes.join('. ');
    }
  }
  announcedProjectStatuses = next;
  announcedFolderAccess = nextFolderAccess;
}

function clearProjectFilters() {
  const search = document.getElementById('project-search');
  if (search) {
    search.value = '';
  }
  searchQuery = '';
  selectedTagFilter = '';
  selectedGroupFilter = '';
  reviewFilterActive = false;
  publishFilterState('setSearchQuery');
  applyProjectFilter('');
}

function handleClearFilters() {
  clearProjectFilters();
  renderList();
  requestAnimationFrame(() => {
    document.getElementById('project-search')?.focus();
    const status = document.getElementById('project-search-status');
    if (status) {
      status.textContent = 'No projects match. Filters cleared.';
    }
  });
}

function applyProjectFilter(query) {
  searchQuery = query;
  const normalizedQuery = normalizeSearchQuery(query);
  const normalizedTag = normalizeTagIdentity(selectedTagFilter);
  const activeGroup = (state.groups || []).find((group) => String(group.id) === selectedGroupFilter);
  const groupMemberIds = activeGroup
    ? new Set((activeGroup.projectIds || []).map(String))
    : undefined;
  const matchingProjects = state.projects.filter((project) => {
    const searchableText = String(
      project.searchText || [project.name, project.folder].filter(Boolean).join('\n')
    ).toLocaleLowerCase();
    const matchesQuery = !normalizedQuery || searchableText.includes(normalizedQuery);
    const matchesTag = !normalizedTag || (project.tags || []).some((tag) => (
      normalizeTagIdentity(tag) === normalizedTag
    ));
    const matchesGroup = !groupMemberIds || groupMemberIds.has(String(project.id));
    const matchesReview = !reviewFilterActive || project.reviewRequired === true;
    return matchesQuery && matchesTag && matchesGroup && matchesReview;
  });
  const matchingIds = new Set(matchingProjects.map((project) => String(project.id)));

  document.querySelectorAll('.project-row').forEach((row) => {
    row.hidden = !matchingIds.has(row.dataset.projectId);
  });

  const filtering = normalizedQuery.length > 0
    || normalizedTag.length > 0
    || Boolean(activeGroup)
    || reviewFilterActive;
  const projectCount = document.getElementById('project-count');
  if (projectCount) {
    projectCount.innerHTML = filtering
      ? `<strong>${matchingIds.size}</strong> of ${state.projects.length} projects`
      : `<strong>${state.projects.length}</strong> ${state.projects.length === 1 ? 'project' : 'projects'}`;
  }

  const summaryStatus = document.getElementById('summary-status');
  if (summaryStatus) {
    summaryStatus.innerHTML = statusSummaryHtml(matchingProjects);
  }
  const attentionSlot = document.getElementById('summary-attention-slot');
  if (attentionSlot) {
    attentionSlot.innerHTML = attentionSummaryHtml(state.projects);
  }

  const emptyState = document.querySelector('[data-search-empty]');
  if (emptyState) {
    emptyState.hidden = !filtering || matchingIds.size > 0;
  }

  const status = document.getElementById('project-search-status');
  if (status) {
    const filters = [
      normalizedTag ? `tag ${selectedTagFilter}` : '',
      activeGroup ? `group ${activeGroup.name}` : '',
      reviewFilterActive ? 'review setup' : ''
    ].filter(Boolean);
    status.textContent = filtering
      ? `${matchingIds.size} ${matchingIds.size === 1 ? 'project' : 'projects'} shown${filters.length ? `, filtered by ${filters.join(' and ')}` : ''}`
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
    clearProjectFilters();
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
  const editingProfileId = String(
    draft?.editingLaunchProfileId
    || draft?.selectedLaunchProfileId
    || 'default'
  );
  const port = Number(draftLaunchProfileOptions(draft)
    .find((profile) => profile.id === editingProfileId)?.services?.[serviceIndex]?.port);
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
  const profileOptions = draftLaunchProfileOptions(state.draft);
  const showLaunchProfileEditor = profileOptions.length > 1 || (editing && !reviewing);
  const editingProfileId = String(
    state.draft.editingLaunchProfileId
    || state.draft.selectedLaunchProfileId
    || 'default'
  );
  const activeProfile = profileOptions.find((profile) => profile.id === editingProfileId)
    || profileOptions[0];
  const services = activeProfile.services || [];
  const serviceRows = services.map((service, index) => {
    const nameField = `service-name-${index}`;
    const portField = `service-port-${index}`;
    const urlField = `service-url-${index}`;
    const healthModeField = `service-health-mode-${index}`;
    const healthTargetField = `service-health-target-${index}`;
    const healthMethodField = `service-health-method-${index}`;
    const healthStatusField = `service-health-status-${index}`;
    const healthTimeoutField = `service-health-timeout-${index}`;
    const healthRetriesField = `service-health-retries-${index}`;
    const health = service.healthCheck || {
      mode: 'default', target: '', method: 'HEAD', expectedStatus: '', timeoutMs: '700', retries: '0'
    };
    const warning = sharedPortWarningText(state.draft, index);
    const serviceOptionsSet = Boolean(String(service.url || '').trim()) || health.mode !== 'default';
    const serviceOptionsInvalid = [
      urlField,
      healthModeField,
      healthTargetField,
      healthMethodField,
      healthStatusField,
      healthTimeoutField,
      healthRetriesField
    ].some((field) => Boolean(errors[field]));
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
        <details class="service-options" ${serviceOptionsInvalid ? 'open' : ''}>
          <summary>Options${serviceOptionsSet ? ' <span class="optional-label">Set</span>' : ''}</summary>
          <div class="service-options-fields">
            <div class="service-field">
              <label class="service-url-label" for="${urlField}">Open URL <span class="optional-label">Optional</span></label>
              <input id="${urlField}" class="service-input" name="serviceUrl" type="url" inputmode="url" value="${escapeHtml(String(service.url ?? ''))}" placeholder="https://app.local/dashboard" maxlength="2048" autocomplete="off" spellcheck="false" aria-label="Service ${index + 1} open URL, optional" ${errorAttributes(urlField)}>
              ${fieldError(urlField)}
            </div>
            <div class="service-field">
              <label class="service-url-label" for="${healthModeField}">Health check</label>
              <select id="${healthModeField}" name="serviceHealthMode" data-service-health-mode="${index}" ${errorAttributes(healthModeField)}>
                <option value="default" ${health.mode === 'default' ? 'selected' : ''}>Default</option>
                <option value="port" ${health.mode === 'port' ? 'selected' : ''}>Port only</option>
                <option value="http" ${health.mode === 'http' ? 'selected' : ''}>HTTP request</option>
              </select>
              ${fieldError(healthModeField)}
              <p class="field-hint">Default uses the Open URL when set; otherwise it checks only the port.</p>
            </div>
            ${health.mode === 'http' ? `
              <div class="service-health-fields">
                <div class="service-field service-health-wide">
                  <label class="service-url-label" for="${healthTargetField}">Health URL or path <span class="optional-label">Optional</span></label>
                  <input id="${healthTargetField}" class="service-input" name="serviceHealthTarget" value="${escapeHtml(health.target || '')}" placeholder="/health" autocomplete="off" spellcheck="false" ${errorAttributes(healthTargetField)}>
                  ${fieldError(healthTargetField)}
                </div>
                <div class="service-field">
                  <label class="service-url-label" for="${healthMethodField}">Method</label>
                  <select id="${healthMethodField}" name="serviceHealthMethod" ${errorAttributes(healthMethodField)}>
                    <option value="HEAD" ${health.method === 'HEAD' ? 'selected' : ''}>HEAD</option>
                    <option value="GET" ${health.method === 'GET' ? 'selected' : ''}>GET</option>
                  </select>
                  ${fieldError(healthMethodField)}
                </div>
                <div class="service-field">
                  <label class="service-url-label" for="${healthStatusField}">Expected status <span class="optional-label">Optional</span></label>
                  <input id="${healthStatusField}" class="service-input" name="serviceHealthStatus" type="number" min="100" max="599" value="${escapeHtml(String(health.expectedStatus ?? ''))}" placeholder="Any" ${errorAttributes(healthStatusField)}>
                  ${fieldError(healthStatusField)}
                </div>
                <div class="service-field">
                  <label class="service-url-label" for="${healthTimeoutField}">Timeout (ms)</label>
                  <input id="${healthTimeoutField}" class="service-input" name="serviceHealthTimeout" type="number" min="100" max="3000" step="100" value="${escapeHtml(String(health.timeoutMs ?? 700))}" ${errorAttributes(healthTimeoutField)}>
                  ${fieldError(healthTimeoutField)}
                </div>
                <div class="service-field">
                  <label class="service-url-label" for="${healthRetriesField}">Retries</label>
                  <input id="${healthRetriesField}" class="service-input" name="serviceHealthRetries" type="number" min="0" max="2" step="1" value="${escapeHtml(String(health.retries ?? 0))}" ${errorAttributes(healthRetriesField)}>
                  ${fieldError(healthRetriesField)}
                </div>
              </div>` : ''}
          </div>
        </details>
        <p class="shared-port-warning service-warning" data-service-warning="${index}" role="status" ${warning ? '' : 'hidden'}>${escapeHtml(warning)}</p>
      </div>`;
  }).join('');
  const isFirstAdd = state.mode === 'add' && !reviewing;
  const advancedFieldErrors = Object.keys(errors).some((field) => (
    field !== 'form'
    && field !== 'folder'
    && field !== 'start-command'
  ));
  const advancedOpen = !isFirstAdd || advancedFieldErrors || Boolean(
    String(state.draft.name || '').trim()
    || String(state.draft.localHostname || '').trim()
    || String(state.draft.tags || '').trim()
    || String(activeProfile.stopCommand || '').trim()
    || String(activeProfile.envFile || '').trim()
    || String(activeProfile.envText || '').trim()
    || (activeProfile.services || []).length
    || showLaunchProfileEditor
  );
  const workspaceFolderControls = (() => {
    const folders = Array.isArray(state.workspaceFolders) ? state.workspaceFolders : [];
    if (!state.canUseCurrentWorkspace) {
      return '';
    }
    if (folders.length > 1 && !state.currentWorkspaceFolder) {
      return `<div class="workspace-folder-choices" role="group" aria-label="Workspace folders in this window">${folders.map((entry) => `<button class="workspace-button" type="button" data-action="select-workspace-folder" data-folder="${escapeHtml(entry.folder)}" title="${escapeHtml(entry.folder)}">${escapeHtml(entry.name || entry.folder)}</button>`).join('')}</div>`;
    }
    return '<button class="workspace-button" type="button" data-action="use-current-workspace">Use current workspace</button>';
  })();
  app.innerHTML = `
    <section class="add-screen">
      <header class="screen-header">
        <h2>${reviewing ? 'Review project setup' : editing ? 'Edit project' : 'Add this folder'}</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close ${reviewing ? 'review project' : editing ? 'edit project' : 'add this folder'} screen">${icon('close')}</button>
      </header>
      ${reviewing ? '<p class="screen-copy">A coding agent added or updated this setup. Check its folder, commands, and services before approving.</p>' : ''}
      <form id="project-form" novalidate>
        ${errors.form ? `<p id="form-error-summary" class="form-error-summary" role="alert" tabindex="-1">${escapeHtml(errors.form)}</p>` : ''}
        <label for="folder">Project folder</label>
        <div class="folder-control">
          <input id="folder" name="folder" value="${escapeHtml(state.draft.folder || '')}" placeholder="Choose a folder" ${errorAttributes('folder')}>
          <button class="browse-button" type="button" data-action="pick-folder">Browse</button>
        </div>
        ${workspaceFolderControls}
        ${fieldError('folder')}

        <label for="start-command">Start command</label>
        <input id="start-command" name="startCommand" value="${escapeHtml(activeProfile.startCommand || '')}" placeholder="npm run dev" ${errorAttributes('start-command')}>
        ${draftStartScriptChipsHtml()}
        ${fieldError('start-command')}

        <details class="more-options"${advancedOpen ? ' open' : ''}>
          <summary>More options</summary>
          <label for="project-name">Project name <span class="optional-label">Optional</span></label>
          <input id="project-name" name="name" value="${escapeHtml(state.draft.name || '')}" placeholder="Defaults to folder name" maxlength="100" ${errorAttributes('project-name')}>
          ${fieldError('project-name')}

          <label for="local-hostname">Local hostname <span class="optional-label">Optional</span></label>
          <input id="local-hostname" name="localHostname" value="${escapeHtml(state.draft.localHostname || '')}" placeholder="Defaults from project name" maxlength="63" autocomplete="off" spellcheck="false" ${errorAttributes('local-hostname')}>
          <p class="field-hint">Open uses http://name.localhost:port on this machine. Leave blank to derive from the project name.</p>
          ${fieldError('local-hostname')}

          <label for="tags">Tags <span class="optional-label">Optional</span></label>
          <input id="tags" name="tags" value="${escapeHtml(state.draft.tags || '')}" placeholder="frontend, customer portal" maxlength="406" autocomplete="off" spellcheck="false" ${errorAttributes('tags')}>
          ${fieldError('tags')}

          ${showLaunchProfileEditor ? `
          <fieldset class="launch-profile-editor" ${state.servicesLocked ? 'disabled' : ''}>
            <legend>Launch profile</legend>
            <div class="launch-profile-toolbar">
              <label class="visually-hidden" for="launch-profile-select">Launch profile</label>
              <select id="launch-profile-select" name="launchProfileId" aria-describedby="launch-profile-hint">
                ${profileOptions.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === activeProfile.id ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`).join('')}
              </select>
              <button type="button" class="profile-tool-button" data-action="add-launch-profile" ${profileOptions.length >= 12 ? 'disabled' : ''}>Add</button>
              <button type="button" class="profile-tool-button" data-action="delete-launch-profile" ${activeProfile.id === 'default' ? 'disabled' : ''}>Delete</button>
            </div>
            ${activeProfile.id === 'default' ? '' : `
              <label for="launch-profile-name">Profile name</label>
              <input id="launch-profile-name" name="launchProfileName" value="${escapeHtml(activeProfile.name)}" maxlength="100" ${errorAttributes('launch-profile-name')}>
              ${fieldError('launch-profile-name')}`}
            <p id="launch-profile-hint" class="field-hint">${state.servicesLocked ? 'Stop this project before choosing another profile.' : 'Choose which saved commands and services Start will use.'}</p>
          </fieldset>` : ''}

          <label for="stop-command">Custom stop command <span class="optional-label">Optional</span></label>
          <input id="stop-command" name="stopCommand" value="${escapeHtml(activeProfile.stopCommand || '')}" placeholder="docker compose down" ${errorAttributes('stop-command')}>
          ${fieldError('stop-command')}
          <p class="field-hint">Leave blank unless this project needs its own stop command.</p>

          <label for="env-file">Env file <span class="optional-label">Optional</span></label>
          <input id="env-file" name="envFile" value="${escapeHtml(activeProfile.envFile || '')}" placeholder=".env" maxlength="256" autocomplete="off" spellcheck="false" ${errorAttributes('env-file')}>
          ${fieldError('env-file')}
          <p class="field-hint">Relative to the project folder. Required at Start if set. Keep secrets in the file, not in Runlist export.</p>

          <label for="env-map">Env overrides <span class="optional-label">Optional</span></label>
          <textarea id="env-map" name="envText" rows="3" placeholder="FLAG=1" spellcheck="false" ${errorAttributes('env-map')}>${escapeHtml(activeProfile.envText || '')}</textarea>
          ${fieldError('env-map')}
          <p class="field-hint">Non-secret KEY=value lines. Applied after the env file. Temporary ports still win.</p>

          <fieldset id="services" class="service-editor" ${state.servicesLocked ? 'disabled' : ''} ${errors.services ? 'aria-invalid="true" aria-describedby="services-hint services-error" tabindex="-1"' : 'aria-describedby="services-hint"'}>
            <legend>Services <span class="optional-label">Optional</span></legend>
            <p id="services-hint" class="field-hint">${state.servicesLocked ? 'Stop this project before changing its services.' : 'Add up to 32 named service ports.'}</p>
            ${errors.services ? `<p id="services-error" class="field-error" role="alert">${escapeHtml(errors.services)}</p>` : ''}
            <div class="service-list-header" aria-hidden="true"><span>Name</span><span>Port</span></div>
            <div class="service-list">
              ${serviceRows || '<p class="empty-services">No services configured.</p>'}
            </div>
            <button class="service-add-button" type="button" data-action="add-service" ${services.length >= 32 ? 'disabled' : ''}>Add service</button>
          </fieldset>
        </details>

        <button class="primary-button save-button" type="submit">${reviewing ? 'Approve setup' : editing ? 'Save changes' : 'Save project'}</button>
        ${reviewing ? '<p class="form-hint">Approving makes Start and Stop available for this project.</p>' : editing ? '<p class="form-hint">Changes apply the next time you start this project.</p>' : ''}
      </form>
    </section>`;
}

function draftStartScriptChipsHtml() {
  if (state.mode !== 'add') {
    return '';
  }
  const scripts = Array.isArray(state.draftStartScripts)
    ? state.draftStartScripts.filter((script) => script
      && ['start', 'dev'].includes(script.name)
      && typeof script.startCommand === 'string'
      && script.startCommand.trim())
    : [];
  const notice = state.draftStartCommandNotice
    ? `<p class="visually-hidden" role="status">${escapeHtml(String(state.draftStartCommandNotice))}</p>`
    : '';
  if (!scripts.length) {
    return notice;
  }
  return `
        <div class="empty-start-chips draft-start-chips" role="group" aria-label="Suggested start commands for this folder">
          ${scripts.map((script) => {
            const chipLabel = script.name === 'dev' ? 'Dev' : 'Start';
            const chipHint = `Use \u201C${script.startCommand}\u201D`;
            const chipName = `Use ${script.startCommand} for the start command`;
            return `
            <button type="button" class="empty-start-chip" data-action="use-draft-start-script" data-script="${escapeHtml(script.name)}" title="${escapeHtml(chipHint)}" aria-label="${escapeHtml(chipName)}">
              ${escapeHtml(chipLabel)}
            </button>`;
          }).join('')}
        </div>
        ${notice}`;
}

function renderAgentSetup() {
  const agentCard = (id, name, description) => {
    const connection = state.agentConnections?.[id] || { status: 'idle', message: '' };
    const busy = connection.status === 'loading';
    const handoffReady = connection.status === 'success';
    const skillInstalled = connection.status === 'installed' || handoffReady;
    const messageId = `${id}-connection-message`;
    const statusLabel = handoffReady
      ? 'Ready for handoff'
      : (skillInstalled ? 'Skill installed' : '');
    return `
      <article class="agent-card">
        <div class="agent-card-heading">
          <div>
            <h3>${escapeHtml(name)}</h3>
            <p>${escapeHtml(description)}</p>
          </div>
          ${statusLabel ? `<span class="connection-label"><span class="status-dot running" aria-hidden="true"></span>${escapeHtml(statusLabel)}</span>` : ''}
        </div>
        <button class="secondary-button agent-register-button" data-action="register-agent" data-agent="${id}" ${busy ? 'disabled aria-busy="true"' : ''} ${connection.message ? `aria-describedby="${messageId}"` : ''}>
          ${busy ? 'Setting up…' : skillInstalled ? 'Refresh setup' : 'Set up'}
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
      <p class="screen-copy">Connect an agent to save projects and read saved status with MCP. After you set up GitHub Copilot here, <strong>Ask your agent</strong> opens VS Code chat with a prefilled diagnosis request you can send. Codex and Claude setup installs the skill for MCP only. Cursor uses the same VS Code MCP integration as Copilot.</p>
      <div class="agent-list" aria-label="Supported coding agents">
        ${agentCard('copilot', 'GitHub Copilot', 'Adds /runlist. Read saved project status with MCP. After setup here, Ask your agent opens VS Code chat with a prefilled diagnosis request.')}
        ${agentCard('codex', 'Codex', 'Registers the connection and adds $runlist. Read saved project status with MCP. Does not open VS Code chat handoffs.')}
        ${agentCard('claude', 'Claude Code', 'Registers the connection and adds /runlist. Read saved project status with MCP. Does not open VS Code chat handoffs.')}
      </div>
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
      ${projectOutput.agentHandoffNotice ? `<p class="diagnosis-copy-status" role="status" aria-live="polite">${escapeHtml(projectOutput.agentHandoffNotice)}</p>` : ''}
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

function renderStackReview() {
  const review = state.stackReview;
  if (!review) {
    app.innerHTML = '<section class="diagnosis-screen"><p class="screen-copy">This stack review is no longer available.</p></section>';
    return;
  }
  const entries = Array.isArray(review.entries) ? review.entries : [];
  const groups = Array.isArray(review.groups) ? review.groups : [];
  const statusLabel = {
    add: 'Add',
    update: 'Update',
    skip: 'Skip',
    invalid: 'Invalid'
  };
  const rows = entries.map((entry) => `
    <article class="stack-review-row" role="listitem">
      <div class="stack-review-topline">
        <strong>${escapeHtml(entry.name || 'Unnamed project')}</strong>
        <span class="stack-review-status status-${escapeHtml(entry.status || 'skip')}">${escapeHtml(statusLabel[entry.status] || entry.status || 'Skip')}</span>
      </div>
      <p class="stack-review-folder">${escapeHtml(entry.folder || '')}</p>
      ${entry.reason ? `<p class="stack-review-reason">${escapeHtml(entry.reason)}</p>` : ''}
    </article>`).join('');
  const groupRows = groups.length ? `
    <h3 class="diagnosis-heading">Groups</h3>
    <ul class="stack-review-groups">
      ${groups.map((group) => `<li><strong>${escapeHtml(group.name)}</strong> — ${(group.projectFolders || []).map((folder) => escapeHtml(folder)).join(', ')} (${escapeHtml(group.startMode || 'sequential')})</li>`).join('')}
    </ul>` : '';
  const canLoad = Number(review.changeCount) > 0;
  app.innerHTML = `
    <section class="diagnosis-screen stack-review-screen" aria-label="Review workspace stack">
      <header class="screen-header">
        <h2>Review stack</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close stack review">${icon('close')}</button>
      </header>
      <p class="screen-copy">From <code>${escapeHtml(review.contractPath || 'runlist.json')}</code>. Added and updated commands stay blocked until you review each setup.</p>
      <div class="stack-review-list" role="list">
        ${rows || '<p class="screen-copy" role="status">No project setups found.</p>'}
      </div>
      ${groupRows}
      <div class="repair-actions">
        <button class="primary-button" data-action="approve-stack-review"${canLoad ? '' : ' disabled'}>${canLoad ? `Load ${review.changeCount} setup${review.changeCount === 1 ? '' : 's'}` : 'Nothing to load'}</button>
        <button class="secondary-button" data-action="close-screen">Cancel</button>
      </div>
    </section>`;
}

function renderComposeImport() {
  const draft = state.composeImport;
  if (!draft?.proposedProject) {
    app.innerHTML = '<section class="diagnosis-screen"><p class="screen-copy">This Compose review is no longer available.</p></section>';
    return;
  }
  const services = Array.isArray(draft.parsedServices) ? draft.parsedServices : [];
  const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  const proposed = draft.proposedProject;
  const rows = services.map((service) => {
    const ports = (service.ports || []).map((port) => `:${port}`).join(', ') || 'No published host port';
    const profiles = (service.profiles || []).length
      ? `Profiles: ${service.profiles.join(', ')}`
      : '';
    return `
      <article class="compose-import-row">
        <div class="compose-import-topline">
          <strong>${escapeHtml(service.name)}</strong>
          <span class="compose-import-ports">${escapeHtml(ports)}</span>
        </div>
        ${profiles ? `<p class="compose-import-profiles">${escapeHtml(profiles)}</p>` : ''}
        ${service.note ? `<p class="compose-import-note">${escapeHtml(service.note)}</p>` : ''}
      </article>`;
  }).join('');

  app.innerHTML = `
    <section class="diagnosis-screen compose-import-screen" aria-label="Review Compose import">
      <header class="screen-header">
        <h2>Review Compose import</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close Compose import">${icon('close')}</button>
      </header>
      <p class="screen-copy">From <code>${escapeHtml(draft.composePath || 'Compose file')}</code>. Runlist has not started Docker or Compose.</p>
      <p class="screen-copy">Proposed project <strong>${escapeHtml(proposed.name)}</strong> with start <code>${escapeHtml(proposed.startCommand)}</code>.</p>
      ${warnings.length ? `<ul class="compose-import-warnings" role="status">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
      <div class="compose-import-list" role="list">
        ${rows || '<p class="screen-copy" role="status">No Compose services were found.</p>'}
      </div>
      <div class="repair-actions">
        <button class="primary-button" data-action="approve-compose-import"${proposed.services?.length ? '' : ' disabled'}>Save reviewed services</button>
        <button class="secondary-button" data-action="close-screen">Cancel</button>
      </div>
    </section>`;
}

function renderPortListening() {
  const report = state.portListening || { rows: [], empty: true };
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const rowHtml = rows.length
    ? rows.map((row) => {
      const port = Number(row.port);
      const kindLabel = row.kind === 'owned'
        ? 'Runlist'
        : row.kind === 'external'
          ? 'External'
          : row.kind === 'gone'
            ? 'Idle'
            : row.kind === 'ambiguous'
              ? 'Unclear'
              : 'Unknown';
      const processLabel = row.kind === 'gone'
        ? 'Nothing listening'
        : [
          row.name || 'Unknown process',
          Number.isInteger(row.pid) ? `PID ${row.pid}` : null
        ].filter(Boolean).join(' · ');
      const ownerLabel = row.kind === 'owned' && row.projectName
        ? row.projectName
        : (row.configuredProjects || []).map((project) => project.name).join(', ');
      return `
        <article class="port-listening-row" data-port="${port}">
          <div class="port-listening-topline">
            <strong class="port-listening-port">:${escapeHtml(String(port))}</strong>
            <span class="port-listening-kind kind-${escapeHtml(row.kind || 'unknown')}">${escapeHtml(kindLabel)}</span>
          </div>
          <p class="port-listening-process">${escapeHtml(processLabel)}</p>
          ${ownerLabel ? `<p class="port-listening-owner">${escapeHtml(ownerLabel)}</p>` : ''}
          <p class="port-listening-reason">${escapeHtml(row.plainReason || '')}</p>
          <div class="port-listening-actions">
            <button type="button" class="secondary-button" data-action="copy-port-listening" data-port="${port}">Copy</button>
            ${row.canReveal && row.projectId ? `
              <button type="button" class="secondary-button" data-action="reveal-listening-project" data-id="${escapeHtml(row.projectId)}">Show project</button>` : ''}
            ${row.canClose && row.closeProjectId ? `
              <button type="button" class="secondary-button" data-action="force-close-ports" data-id="${escapeHtml(row.closeProjectId)}" data-port="${port}">Close listener…</button>` : ''}
          </div>
        </article>`;
    }).join('')
    : `<p class="screen-copy" role="status">No configured project ports yet. Add a project with a service port to diagnose listeners here.</p>`;

  app.innerHTML = `
    <section class="diagnosis-screen port-listening-screen" aria-label="What's listening">
      <header class="screen-header">
        <h2>What's listening</h2>
        <div class="screen-header-actions">
          <button type="button" class="secondary-button" data-action="refresh-port-listening">Refresh</button>
          <button type="button" class="secondary-button" data-action="copy-port-listening">Copy all</button>
          <button class="icon-button" data-action="close-screen" aria-label="Close what's listening">${icon('close')}</button>
        </div>
      </header>
      <p class="screen-copy">Configured project ports only. Runlist never closes a listener without an exact port and PID confirmation.</p>
      <div class="port-listening-list" role="list">
        ${rowHtml}
      </div>
    </section>`;
}

function renderPortResolve() {
  const resolve = state.portResolve;
  if (!resolve || !Array.isArray(resolve.choices) || !resolve.choices.length) {
    app.innerHTML = `
      <section class="diagnosis-screen port-resolve-screen" aria-label="Resolve port">
        <header class="screen-header">
          <h2>Resolve port</h2>
          <button class="icon-button" data-action="close-screen" aria-label="Close resolve port">${icon('close')}</button>
        </header>
        <p class="screen-copy">This port resolve is no longer available.</p>
      </section>`;
    return;
  }
  const projectName = escapeHtml(resolve.projectName || 'Project');
  const serviceName = escapeHtml(resolve.serviceName || 'service');
  const portLabel = `:${Number(resolve.port)}`;
  app.innerHTML = `
    <section class="diagnosis-screen port-resolve-screen" aria-label="Resolve port for ${projectName}">
      <header class="screen-header">
        <h2>Resolve port</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close resolve port">${icon('close')}</button>
      </header>
      <p class="screen-copy"><strong>${projectName}</strong> · ${serviceName} ${escapeHtml(portLabel)}</p>
      <p class="screen-copy">Choose how Runlist should handle this service port. Closing an external listener still asks for confirmation with the exact port and PID.</p>
      <div class="port-resolve-choices" role="list">
        ${resolve.choices.map((choice, index) => `
          <button type="button" class="port-resolve-choice ${index === 0 ? 'primary-button' : 'secondary-button'}" data-action="choose-port-resolve" data-resolve-action="${escapeHtml(choice.action)}" role="listitem">
            <strong>${escapeHtml(choice.label)}</strong>
            <span>${escapeHtml(choice.description || '')}</span>
          </button>`).join('')}
      </div>
    </section>`;
}

function beginRunGroupDraft(group) {
  if (group) {
    runGroupDraft = {
      id: String(group.id),
      name: String(group.name || ''),
      projectIds: [...(group.projectIds || [])].map(String),
      startMode: group.startMode === 'parallel' ? 'parallel' : 'sequential'
    };
    return;
  }
  runGroupDraft = {
    name: '',
    projectIds: [],
    startMode: 'sequential'
  };
}

function syncRunGroupDraftFromForm() {
  if (!runGroupDraft) {
    return;
  }
  const nameInput = document.getElementById('run-group-name');
  if (nameInput) {
    runGroupDraft.name = String(nameInput.value || '');
  }
  const modeSelect = document.getElementById('run-group-mode');
  if (modeSelect) {
    runGroupDraft.startMode = modeSelect.value === 'parallel' ? 'parallel' : 'sequential';
  }
}

function clearRunGroupDraft() {
  runGroupDraft = undefined;
}

function renderRunGroupsEditor() {
  const editor = state.runGroupsEditor || {};
  const availableProjects = Array.isArray(editor.availableProjects) ? editor.availableProjects : [];
  const groups = Array.isArray(state.groups) ? state.groups : [];
  if (runGroupDraft === undefined && editor.focusGroupId) {
    const focused = groups.find((group) => String(group.id) === String(editor.focusGroupId));
    if (focused) {
      beginRunGroupDraft(focused);
    }
  }

  if (runGroupDraft) {
    const draft = runGroupDraft;
    const projectsById = new Map(availableProjects.map((project) => [String(project.id), project]));
    const unusedProjects = availableProjects.filter((project) => !draft.projectIds.includes(String(project.id)));
    const title = draft.id ? 'Edit group' : 'Create group';
    app.innerHTML = `
      <section class="diagnosis-screen run-groups-screen" aria-label="${title}">
        <header class="screen-header">
          <h2>${title}</h2>
          <button class="icon-button" data-action="close-run-group-draft" aria-label="Back to run groups">${icon('close')}</button>
        </header>
        <label class="screen-field" for="run-group-name">Name</label>
        <input id="run-group-name" type="text" maxlength="100" value="${escapeHtml(draft.name)}" autocomplete="off" spellcheck="false">
        <label class="screen-field" for="run-group-mode">Start mode</label>
        <select id="run-group-mode">
          <option value="sequential" ${draft.startMode === 'parallel' ? '' : 'selected'}>Sequential</option>
          <option value="parallel" ${draft.startMode === 'parallel' ? 'selected' : ''}>Parallel</option>
        </select>
        <p class="screen-copy">Projects start in the order shown.</p>
        <div class="run-group-editor-members" role="list">
          ${draft.projectIds.length ? draft.projectIds.map((projectId, index) => {
            const project = projectsById.get(String(projectId));
            const label = escapeHtml(project?.name || 'Missing project');
            return `
              <div class="run-group-editor-member" role="listitem" data-project-id="${escapeHtml(String(projectId))}">
                <span><strong>${index + 1}.</strong> ${label}</span>
                <div class="run-group-editor-member-actions">
                  <button type="button" data-action="move-run-group-member" data-project-id="${escapeHtml(String(projectId))}" data-direction="up" aria-label="Move ${label} earlier" ${index === 0 ? 'disabled' : ''}>${icon('chevron-up')}</button>
                  <button type="button" data-action="move-run-group-member" data-project-id="${escapeHtml(String(projectId))}" data-direction="down" aria-label="Move ${label} later" ${index === draft.projectIds.length - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button>
                  <button type="button" data-action="remove-run-group-member" data-project-id="${escapeHtml(String(projectId))}" aria-label="Remove ${label}">${icon('close')}</button>
                </div>
              </div>`;
          }).join('') : '<p class="screen-copy">Add at least one saved project.</p>'}
        </div>
        ${unusedProjects.length && draft.projectIds.length < 20 ? `
          <label class="screen-field" for="run-group-add-project">Add to group</label>
          <div class="run-group-add-row">
            <select id="run-group-add-project">
              ${unusedProjects.map((project) => `<option value="${escapeHtml(String(project.id))}">${escapeHtml(project.name)}</option>`).join('')}
            </select>
            <button type="button" class="secondary-button" data-action="add-run-group-member">Add</button>
          </div>` : ''}
        <div class="screen-actions">
          <button type="button" class="primary-button" data-action="save-run-group-draft" ${draft.projectIds.length ? '' : 'disabled'}>Save group</button>
          <button type="button" class="secondary-button" data-action="close-run-group-draft">Cancel</button>
        </div>
      </section>`;
    return;
  }

  app.innerHTML = `
    <section class="diagnosis-screen run-groups-screen" aria-label="Run groups">
      <header class="screen-header">
        <h2>Run groups</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close run groups">${icon('close')}</button>
      </header>
      <p class="screen-copy">Save an ordered set of projects to start and stop together. Filter the list from Groups when a group exists.</p>
      <div class="screen-actions">
        <button type="button" class="primary-button" data-action="create-run-group" ${availableProjects.length ? '' : 'disabled'}>Create group</button>
      </div>
      ${!availableProjects.length ? '<p class="screen-copy">Add a project before creating a run group.</p>' : ''}
      <div class="run-group-editor-list" role="list">
        ${groups.length ? groups.map((group) => `
          <article class="run-group-editor-row" role="listitem">
            <div>
              <strong>${escapeHtml(group.name)}</strong>
              <p>${group.projectIds.length} project${group.projectIds.length === 1 ? '' : 's'} · ${group.startMode === 'parallel' ? 'Parallel' : 'Sequential'}</p>
            </div>
            <div class="run-group-editor-row-actions">
              <button type="button" class="secondary-button" data-action="edit-run-group" data-id="${escapeHtml(group.id)}">Edit</button>
              <button type="button" class="secondary-button" data-action="remove-run-group" data-id="${escapeHtml(group.id)}">Remove</button>
            </div>
          </article>`).join('') : '<p class="screen-copy">No run groups yet.</p>'}
      </div>
    </section>`;
}

function renderProjectDiagnosis() {
  const diagnosis = state.diagnosis;
  if (!diagnosis) {
    app.innerHTML = '<section class="diagnosis-screen"><p class="screen-copy">These diagnostics are no longer available.</p></section>';
    return;
  }
  if (diagnosis.approved) {
    app.innerHTML = `
      <section class="diagnosis-screen">
        <header class="screen-header">
          <h2>Repair approved</h2>
          <button class="icon-button" data-action="close-screen" aria-label="Close approved repair">${icon('close')}</button>
        </header>
        <div class="diagnosis-notice" role="status" aria-live="polite">
          <strong>${escapeHtml(diagnosis.name)} is updated</strong>
          <p>The reviewed setup is saved. Runlist has not started it.</p>
        </div>
        <div class="repair-actions">
          <button class="primary-button" data-action="retry-repair">Retry start</button>
          <button class="secondary-button" data-action="close-screen">Done</button>
        </div>
      </section>`;
    return;
  }
  const repairHtml = diagnosis.repair ? `
    <section class="repair-proposal" aria-labelledby="repair-proposal-heading">
      <h3 id="repair-proposal-heading" class="diagnosis-heading">Repair proposal</h3>
      ${diagnosis.repair.stale ? `
        <p class="repair-stale" role="alert">This proposal is stale or was saved by an older Runlist version. Refresh the diagnosis and review the latest proposal before approving it.</p>` : ''}
      <div class="repair-comparison" role="table" aria-label="Current and proposed project setup">
        <div class="repair-comparison-heading" role="row">
          <strong role="columnheader">Field</strong>
          <strong role="columnheader">Current</strong>
          <strong role="columnheader">Proposed</strong>
        </div>
        ${diagnosis.repair.comparison.map((item) => `
          <div class="repair-comparison-row" role="row">
            <strong role="rowheader">${escapeHtml(item.field)}</strong>
            <span role="cell">${escapeHtml(item.current)}</span>
            <span role="cell">${escapeHtml(item.proposed)}</span>
            <div role="cell" class="repair-change-cell" aria-label="${escapeHtml(`${item.field}: ${item.change}`)}">
              <small class="repair-change ${escapeHtml(item.change)}" aria-hidden="true">${escapeHtml(item.change)}</small>
            </div>
          </div>`).join('')}
      </div>
      <div class="repair-actions">
        <button class="primary-button" data-action="approve-repair" data-proposal-id="${escapeHtml(diagnosis.repair.proposalId)}" ${diagnosis.repair.stale ? 'disabled' : ''}>Approve complete proposal</button>
        <button class="secondary-button" data-action="reject-repair">Reject proposal</button>
      </div>
    </section>` : '';
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
      <button class="secondary-button repair-refresh-button" data-action="refresh-repair">Refresh proposal</button>
      ${repairHtml}
      ${diagnosis.agentReady ? '' : `
        <div class="diagnosis-setup">
          <strong>Need Copilot chat handoff?</strong>
          <p>Set up GitHub Copilot in Agent connections. Codex and Claude skills support MCP status only.</p>
          <button class="secondary-button" data-action="show-agent-connections">Open Agent connections</button>
        </div>`}
      <p class="diagnosis-review-note">A proposal never changes the saved setup or retries the project until you explicitly approve and then choose Retry start.</p>
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

function draftLaunchProfileOptions(draft = {}) {
  const envTextFrom = (value) => {
    if (typeof value?.envText === 'string') {
      return value.envText;
    }
    if (value?.env && typeof value.env === 'object' && !Array.isArray(value.env)) {
      return Object.keys(value.env).sort().map((key) => `${key}=${value.env[key]}`).join('\n');
    }
    return '';
  };
  return [
    {
      id: 'default',
      name: 'Default',
      startCommand: String(draft.startCommand || ''),
      stopCommand: String(draft.stopCommand || ''),
      envFile: String(draft.envFile || ''),
      envText: envTextFrom(draft),
      services: Array.isArray(draft.services) ? draft.services : []
    },
    ...(Array.isArray(draft.launchProfiles) ? draft.launchProfiles : []).map((profile) => ({
      ...profile,
      envFile: String(profile.envFile || ''),
      envText: envTextFrom(profile)
    }))
  ];
}

function currentDraft(
  form = document.getElementById('project-form'),
  editingProfileId = String(
    state.draft.editingLaunchProfileId
    || state.draft.selectedLaunchProfileId
    || 'default'
  )
) {
  const fieldValue = (name) => form?.elements.namedItem(name)?.value || '';
  const activeServices = draftLaunchProfileOptions(state.draft)
    .find((profile) => profile.id === editingProfileId)?.services || [];
  const services = [...(form?.querySelectorAll('.service-row') || [])].map((row, index) => ({
    name: row.querySelector('[name="serviceName"]')?.value || '',
    port: row.querySelector('[name="servicePort"]')?.value || '',
    portVariable: activeServices[index]?.portVariable || '',
    url: row.querySelector('[name="serviceUrl"]')?.value || '',
    healthCheck: {
      mode: row.querySelector('[name="serviceHealthMode"]')?.value || 'default',
      target: row.querySelector('[name="serviceHealthTarget"]')?.value
        ?? activeServices[index]?.healthCheck?.target ?? '',
      method: row.querySelector('[name="serviceHealthMethod"]')?.value
        || activeServices[index]?.healthCheck?.method || 'HEAD',
      expectedStatus: row.querySelector('[name="serviceHealthStatus"]')?.value
        ?? activeServices[index]?.healthCheck?.expectedStatus ?? '',
      timeoutMs: row.querySelector('[name="serviceHealthTimeout"]')?.value
        ?? activeServices[index]?.healthCheck?.timeoutMs ?? '700',
      retries: row.querySelector('[name="serviceHealthRetries"]')?.value
        ?? activeServices[index]?.healthCheck?.retries ?? '0'
    }
  }));
  const draft = {
    ...state.draft,
    id: state.draft.id,
    name: fieldValue('name'),
    localHostname: fieldValue('localHostname'),
    tags: fieldValue('tags'),
    folder: fieldValue('folder'),
    launchProfiles: (state.draft.launchProfiles || []).map((profile) => ({
      ...profile,
      services: (profile.services || []).map((service) => ({ ...service }))
    })),
    selectedLaunchProfileId: String(state.draft.selectedLaunchProfileId || 'default'),
    editingLaunchProfileId: editingProfileId
  };
  const profileValues = {
    startCommand: fieldValue('startCommand'),
    stopCommand: fieldValue('stopCommand'),
    envFile: fieldValue('envFile'),
    envText: fieldValue('envText'),
    services
  };
  if (editingProfileId === 'default') {
    Object.assign(draft, profileValues);
  } else {
    draft.launchProfiles = draft.launchProfiles.map((profile) => profile.id === editingProfileId
      ? {
          ...profile,
          name: fieldValue('launchProfileName'),
          ...profileValues
        }
      : profile);
  }
  return draft;
}

function nextLaunchProfileName(profiles) {
  const names = new Set(profiles.map((profile) => String(profile.name).toLocaleLowerCase()));
  for (let number = 2; number <= 99; number += 1) {
    const name = `Profile ${number}`;
    if (!names.has(name.toLocaleLowerCase())) {
      return name;
    }
  }
  return 'New profile';
}

function updateLaunchProfileDraft(draft, focusId) {
  state.draft = draft;
  state.formErrors = {};
  vscode.postMessage({ type: 'updateDraft', draft });
  renderProjectForm(state.mode);
  requestAnimationFrame(() => document.getElementById(focusId)?.focus());
}

function clearServiceErrors() {
  for (const field of Object.keys(state.formErrors || {})) {
    if (field === 'services' || field.startsWith('service-')) {
      delete state.formErrors[field];
    }
  }
}

function updateServiceDraft(services, focusId) {
  const draft = currentDraft();
  if (draft.editingLaunchProfileId === 'default') {
    draft.services = services;
  } else {
    draft.launchProfiles = (draft.launchProfiles || []).map((profile) => (
      profile.id === draft.editingLaunchProfileId ? { ...profile, services } : profile
    ));
  }
  state.draft = draft;
  clearServiceErrors();
  vscode.postMessage({ type: 'updateDraft', draft: state.draft });
  renderProjectForm(state.mode);
  requestAnimationFrame(() => document.getElementById(focusId)?.focus());
}

function selectProjectDetailTab(id, tab, focus = false) {
  const project = state.projects.find((item) => String(item.id) === String(id));
  if (!project?.detailsExpanded || !project.detailTabs?.includes(tab)) {
    return;
  }
  detailTabState[project.id] = tab;
  saveDetailTabState();
  const row = document.querySelector(`.project-row[data-project-id="${CSS.escape(String(id))}"]`);
  row?.querySelectorAll('[role="tab"]').forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) {
      button.focus();
    }
  });
  row?.querySelectorAll('[data-detail-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.detailPanel !== tab;
  });
  if (tab === 'preview') {
    row?.querySelectorAll('[data-detail-panel="preview"] [data-preview-frame]')
      .forEach(loadProjectPreview);
  }
  scheduleAutoScrollUpdate();
  scheduleRunningAppNavigatorUpdate();
}

function togglePhoneHandoff(id, button) {
  const project = state.projects.find((item) => String(item.id) === String(id));
  if (!project?.previewExpanded || !project.phoneHandoff) {
    return;
  }
  const open = !phoneHandoffState[project.id];
  phoneHandoffState[project.id] = open;
  saveWebviewState();
  const panel = document.getElementById(`phone-handoff-${String(id)}`);
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Hide phone code' : 'Open on phone';
  if (panel) {
    panel.hidden = !open;
    if (open) {
      panel.focus();
    }
  }
}

function showStartupFailure(id, entryKey) {
  const project = state.projects.find((item) => String(item.id) === String(id));
  const entry = project?.startupHistory?.find((item, index) => (
    item.failureSummary && startupHistoryEntryKey(item, index) === entryKey
  ));
  if (!project?.detailsExpanded || !entry) {
    return;
  }
  startupFailureState[project.id] = entryKey;
  saveWebviewState();
  renderList();
  requestAnimationFrame(() => document.getElementById(`startup-failure-${String(id)}`)?.focus());
}

function closeStartupFailure(id, entryKey) {
  delete startupFailureState[id];
  saveWebviewState();
  renderList();
  requestAnimationFrame(() => document.querySelector(
    `[data-action="show-startup-failure"][data-id="${CSS.escape(String(id))}"][data-entry-key="${CSS.escape(String(entryKey))}"]`
  )?.focus());
}

app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    closeMenus();
    return;
  }

  if (!['toggle-menu', 'toggle-profile-menu'].includes(button.dataset.action)) {
    closeMenus();
  }

  const actions = {
    'show-add': () => vscode.postMessage({ type: 'showAdd' }),
    'load-workspace-stack': () => vscode.postMessage({ type: 'loadWorkspaceStack' }),
    'select-workspace-folder': () => vscode.postMessage({
      type: 'selectWorkspaceFolder',
      folder: button.dataset.folder,
      draft: document.getElementById('project-form') ? currentDraft() : undefined
    }),
    'approve-stack-review': () => vscode.postMessage({ type: 'approveStackReview' }),
    'start-workspace-script': () => vscode.postMessage({
      type: 'startWorkspaceScript',
      script: button.dataset.script
    }),
    'use-draft-start-script': () => vscode.postMessage({
      type: 'useDraftStartScript',
      script: button.dataset.script,
      draft: currentDraft()
    }),
    'close-screen': () => {
      clearRunGroupDraft();
      vscode.postMessage({
        type: 'closeScreen',
        draft: document.getElementById('project-form') ? currentDraft() : undefined
      });
    },
    'pick-folder': () => vscode.postMessage({ type: 'pickFolder', draft: currentDraft() }),
    'use-current-workspace': () => vscode.postMessage({ type: 'useCurrentWorkspace', draft: currentDraft() }),
    'add-service': () => {
      const draft = currentDraft();
      const services = draftLaunchProfileOptions(draft)
        .find((profile) => profile.id === draft.editingLaunchProfileId)?.services || [];
      if (services.length < 32) {
        const index = services.length;
        updateServiceDraft([...services, {
          name: '',
          port: '',
          portVariable: '',
          url: '',
          healthCheck: {
            mode: 'default', target: '', method: 'HEAD', expectedStatus: '', timeoutMs: '700', retries: '0'
          }
        }], `service-name-${index}`);
      }
    },
    'add-launch-profile': () => {
      const draft = currentDraft();
      const profiles = draftLaunchProfileOptions(draft);
      if (profiles.length >= 12) {
        return;
      }
      const source = profiles.find((profile) => profile.id === draft.editingLaunchProfileId)
        || profiles[0];
      const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      draft.launchProfiles = [...(draft.launchProfiles || []), {
        id,
        name: nextLaunchProfileName(profiles),
        startCommand: source.startCommand || '',
        stopCommand: source.stopCommand || '',
        envFile: source.envFile || '',
        envText: source.envText || '',
        services: (source.services || []).map((service) => ({ ...service }))
      }];
      draft.selectedLaunchProfileId = id;
      draft.editingLaunchProfileId = id;
      updateLaunchProfileDraft(draft, 'launch-profile-name');
    },
    'delete-launch-profile': () => {
      const draft = currentDraft();
      const id = draft.editingLaunchProfileId;
      if (!id || id === 'default') {
        return;
      }
      draft.launchProfiles = (draft.launchProfiles || []).filter((profile) => profile.id !== id);
      draft.selectedLaunchProfileId = 'default';
      draft.editingLaunchProfileId = 'default';
      updateLaunchProfileDraft(draft, 'launch-profile-select');
    },
    'remove-service': () => {
      const index = Number(button.dataset.serviceIndex);
      const draft = currentDraft();
      const services = (draftLaunchProfileOptions(draft)
        .find((profile) => profile.id === draft.editingLaunchProfileId)?.services || [])
        .filter((service, serviceIndex) => serviceIndex !== index);
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
    'refresh-port-listening': () => vscode.postMessage({ type: 'refreshPortListening' }),
    'copy-port-listening': () => {
      const port = Number(button.dataset.port);
      vscode.postMessage({
        type: 'copyPortListeningDetails',
        ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {})
      });
    },
    'reveal-listening-project': () => vscode.postMessage({
      type: 'revealPortOwnerProject',
      id: button.dataset.id
    }),
    'manage-group': () => vscode.postMessage({ type: 'manageRunGroups', id: button.dataset.id }),
    'toggle-tag-filter': () => {
      tagsExpanded = !tagsExpanded;
      if (tagsExpanded) {
        groupsExpanded = false;
      }
      saveWebviewState();
      renderList();
      requestAnimationFrame(() => document.querySelector('[data-action="toggle-tag-filter"]')?.focus());
    },
    'select-tag-filter': () => {
      const tag = String(button.dataset.tag || '');
      selectedTagFilter = tag && normalizeTagIdentity(tag) === normalizeTagIdentity(selectedTagFilter)
        ? ''
        : tag;
      state.tagFilter = selectedTagFilter;
      tagsExpanded = false;
      saveWebviewState();
      publishFilterState('setTagFilter');
      renderList();
      requestAnimationFrame(() => document.querySelector('[data-action="toggle-tag-filter"]')?.focus());
    },
    'toggle-group-filter': () => {
      groupsExpanded = !groupsExpanded;
      if (groupsExpanded) {
        tagsExpanded = false;
      }
      saveWebviewState();
      renderList();
      requestAnimationFrame(() => document.querySelector('[data-action="toggle-group-filter"]')?.focus());
    },
    'select-group-filter': () => {
      const groupId = String(button.dataset.id || '');
      selectedGroupFilter = groupId && groupId === selectedGroupFilter ? '' : groupId;
      groupsExpanded = false;
      saveWebviewState();
      renderList();
      requestAnimationFrame(() => document.querySelector('[data-action="toggle-group-filter"]')?.focus());
    },
    'toggle-review-filter': () => {
      reviewFilterActive = !reviewFilterActive;
      saveWebviewState();
      publishFilterState('setSearchQuery');
      renderList();
      requestAnimationFrame(() => document.querySelector('[data-action="toggle-review-filter"]')?.focus());
    },
    'create-run-group': () => {
      beginRunGroupDraft();
      renderRunGroupsEditor();
      requestAnimationFrame(() => document.getElementById('run-group-name')?.focus());
    },
    'edit-run-group': () => {
      const group = (state.groups || []).find((item) => String(item.id) === String(button.dataset.id));
      if (!group) {
        return;
      }
      beginRunGroupDraft(group);
      renderRunGroupsEditor();
      requestAnimationFrame(() => document.getElementById('run-group-name')?.focus());
    },
    'close-run-group-draft': () => {
      clearRunGroupDraft();
      renderRunGroupsEditor();
      requestAnimationFrame(() => document.querySelector('[data-action="close-screen"]')?.focus());
    },
    'add-run-group-member': () => {
      if (!runGroupDraft) {
        return;
      }
      syncRunGroupDraftFromForm();
      const select = document.getElementById('run-group-add-project');
      const projectId = String(select?.value || '');
      if (!projectId || runGroupDraft.projectIds.includes(projectId)) {
        return;
      }
      runGroupDraft.projectIds.push(projectId);
      renderRunGroupsEditor();
    },
    'remove-run-group-member': () => {
      if (!runGroupDraft) {
        return;
      }
      syncRunGroupDraftFromForm();
      const projectId = String(button.dataset.projectId || '');
      runGroupDraft.projectIds = runGroupDraft.projectIds.filter((id) => id !== projectId);
      renderRunGroupsEditor();
    },
    'move-run-group-member': () => {
      if (!runGroupDraft) {
        return;
      }
      syncRunGroupDraftFromForm();
      const projectId = String(button.dataset.projectId || '');
      const index = runGroupDraft.projectIds.indexOf(projectId);
      if (index < 0) {
        return;
      }
      const direction = button.dataset.direction;
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= runGroupDraft.projectIds.length) {
        return;
      }
      const next = [...runGroupDraft.projectIds];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      runGroupDraft.projectIds = next;
      renderRunGroupsEditor();
    },
    'save-run-group-draft': () => {
      if (!runGroupDraft) {
        return;
      }
      syncRunGroupDraftFromForm();
      const name = String(runGroupDraft.name || '').trim();
      const startMode = runGroupDraft.startMode === 'parallel' ? 'parallel' : 'sequential';
      if (!name || !runGroupDraft.projectIds.length) {
        return;
      }
      vscode.postMessage({
        type: 'saveRunGroup',
        group: {
          ...(runGroupDraft.id ? { id: runGroupDraft.id } : {}),
          name,
          projectIds: runGroupDraft.projectIds,
          startMode
        }
      });
      clearRunGroupDraft();
    },
    'remove-run-group': () => vscode.postMessage({
      type: 'removeRunGroup',
      id: button.dataset.id
    }),
    'toggle-menu': () => toggleMenu(button),
    'toggle-profile-menu': () => toggleMenu(button),
    'select-launch-profile': () => {
      closeMenus();
      vscode.postMessage({
        type: 'selectLaunchProfile',
        id: button.dataset.id,
        profileId: button.dataset.profileId
      });
    },
    open: () => {
      closeMenus();
      vscode.postMessage({ type: 'openProject', id: button.dataset.id });
    },
    'open-service-url': () => vscode.postMessage({
      type: 'openServiceUrl',
      id: button.dataset.id,
      port: Number(button.dataset.port)
    }),
    'copy-service-url': () => vscode.postMessage({
      type: 'copyServiceUrl',
      id: button.dataset.id,
      port: Number(button.dataset.port)
    }),
    'resolve-service-port': () => {
      vscode.postMessage({
        type: 'resolveServicePort',
        id: button.dataset.id,
        port: Number(button.dataset.port)
      });
    },
    'choose-port-resolve': () => {
      vscode.postMessage({
        type: 'choosePortResolve',
        action: button.dataset.resolveAction
      });
    },
    'focus-attention': () => focusNextAttentionProject(),
    'focus-group-blocking': () => focusGroupBlockingProject(button.dataset.projectId),
    'clear-filters-for-attention': () => handleClearFiltersForAttention(),
    'copy-phone-url': () => vscode.postMessage({
      type: 'copyPhoneUrl',
      id: button.dataset.id,
      url: button.dataset.url
    }),
    'toggle-phone-handoff': () => togglePhoneHandoff(button.dataset.id, button),
    'open-on-phone': () => {
      closeMenus();
      const id = button.dataset.id;
      const project = state.projects.find((item) => String(item.id) === String(id));
      if (!project?.phoneHandoff) {
        return;
      }
      phoneHandoffState[id] = true;
      detailTabState[id] = 'preview';
      saveWebviewState();
      vscode.postMessage({
        type: 'toggleProjectPreview',
        id,
        focusAction: 'focus-phone-handoff'
      });
    },
    'show-startup-failure': () => showStartupFailure(button.dataset.id, button.dataset.entryKey),
    'close-startup-failure': () => closeStartupFailure(button.dataset.id, button.dataset.entryKey),
    'toggle-preview': () => {
      const project = state.projects.find((item) => String(item.id) === String(button.dataset.id));
      if (project?.detailsExpanded) {
        delete detailTabState[project.id];
        saveDetailTabState();
      }
      vscode.postMessage({
        type: 'toggleProjectPreview',
        id: button.dataset.id
      });
    },
    'open-services': () => {
      const project = state.projects.find((item) => String(item.id) === String(button.dataset.id));
      if (!project) {
        return;
      }
      const servicesSelected = project.detailsExpanded
        && selectedProjectDetailTab(project) === 'services';
      detailTabState[project.id] = 'services';
      saveDetailTabState();
      if (!project.detailsExpanded || servicesSelected) {
        vscode.postMessage({ type: 'toggleProjectServices', id: project.id });
      } else {
        renderList();
        requestAnimationFrame(() => document.querySelector(
          `[data-action="open-services"][data-id="${CSS.escape(String(project.id))}"]`
        )?.focus());
      }
    },
    'toggle-service-detail': () => {
      const projectId = String(button.dataset.id);
      const port = String(button.dataset.port);
      expandedServiceState[projectId] = String(expandedServiceState[projectId] || '') === port
        ? ''
        : port;
      saveWebviewState();
      renderList();
      requestAnimationFrame(() => document.querySelector(
        `[data-action="toggle-service-detail"][data-id="${CSS.escape(projectId)}"][data-port="${CSS.escape(port)}"]`
      )?.focus());
    },
    'select-detail-tab': () => selectProjectDetailTab(button.dataset.id, button.dataset.tab),
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
    'copy-error': () => {
      closeMenus();
      vscode.postMessage({ type: 'copyProjectFailure', id: button.dataset.id });
    },
    'relink-folder': () => {
      closeMenus();
      vscode.postMessage({ type: 'relinkProjectFolder', id: button.dataset.id });
    },
    output: () => {
      closeMenus();
      vscode.postMessage({ type: 'showTerminal', id: button.dataset.id });
    },
    'show-terminal': () => {
      closeMenus();
      vscode.postMessage({ type: 'showTerminal', id: button.dataset.id });
    },
    'ask-agent': () => vscode.postMessage({ type: 'askAgentForDiagnosis', id: button.dataset.id }),
    'copy-diagnosis-request': () => vscode.postMessage({ type: 'copyDiagnosisRequest' }),
    'refresh-repair': () => vscode.postMessage({ type: 'refreshProjectRepair' }),
    'approve-repair': () => vscode.postMessage({
      type: 'approveProjectRepair',
      proposalId: button.dataset.proposalId
    }),
    'reject-repair': () => vscode.postMessage({ type: 'rejectProjectRepair' }),
    'retry-repair': () => vscode.postMessage({ type: 'retryProjectRepair' }),
    'open-output-url': () => {
      event.preventDefault();
      vscode.postMessage({ type: 'openOutputUrl', url: button.dataset.url });
    },
    'jump-latest': jumpToLatestOutput,
    'copy-output': () => vscode.postMessage({ type: 'copyOutput' }),
    edit: () => vscode.postMessage({ type: 'showEdit', id: button.dataset.id }),
    'add-stop-command': () => vscode.postMessage({ type: 'showEdit', id: button.dataset.id, focusField: 'stop-command' }),
    'fix-environment': () => vscode.postMessage({
      type: 'showEdit',
      id: button.dataset.id,
      focusTarget: button.dataset.focusTarget || 'env-map'
    }),
    'toggle-pin': () => vscode.postMessage({ type: 'toggleProjectPin', id: button.dataset.id }),
    'clear-filters': handleClearFilters,
    'show-running-app': () => revealRunningApp(button.dataset.id),
    'previous-running-app': () => navigateRunningApps(-1),
    'next-running-app': () => navigateRunningApps(1),
    delete: () => vscode.postMessage({ type: 'deleteProject', id: button.dataset.id }),
    start: () => vscode.postMessage({ type: 'startProject', id: button.dataset.id }),
    stop: () => vscode.postMessage({ type: 'stopProject', id: button.dataset.id }),
    restart: () => vscode.postMessage({ type: 'restartProject', id: button.dataset.id }),
    'force-close-ports': () => {
      closeMenus();
      button.disabled = true;
      const port = Number(button.dataset.port);
      vscode.postMessage({
        type: 'forceCloseProjectPorts',
        id: button.dataset.id,
        ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {})
      });
    },
    'force-close-ports-and-start': () => {
      button.disabled = true;
      vscode.postMessage({ type: 'forceCloseProjectPortsAndStart', id: button.dataset.id });
    },
    'import-compose': () => {
      closeMenus();
      vscode.postMessage({ type: 'showComposeImport', id: button.dataset.id });
    },
    'approve-compose-import': () => {
      button.disabled = true;
      vscode.postMessage({ type: 'approveComposeImport' });
    },
    'start-group': () => vscode.postMessage({ type: 'startRunGroup', id: button.dataset.id }),
    'stop-group': () => vscode.postMessage({ type: 'stopRunGroup', id: button.dataset.id }),
    handoff: () => {
      button.disabled = true;
      vscode.postMessage({ type: 'handoffProject', id: button.dataset.id });
    },
    'stop-all': () => {
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
  const row = frame.closest('.project-row');
  const projectId = String(row?.dataset?.projectId || '');
  const projectIncarnation = frame.dataset.previewIncarnation;
  if (!wrapper || !source || !projectId
    || typeof projectIncarnation !== 'string'
    || projectIncarnation.length === 0
    || projectIncarnations.get(projectId) !== projectIncarnation) {
    return;
  }
  if (frame.dataset.loadedSource === source) {
    return;
  }
  invalidateProjectPreviewLoad();
  frame.dataset.loadedSource = source;

  wrapper.classList.remove('loaded');
  loading.hidden = false;
  fallback.hidden = true;
  const generation = ++previewLoadGeneration;
  let previewLoadOutcome = 'pending';
  const isCurrentLoad = () => generation === previewLoadGeneration
    && activePreviewLoad?.generation === generation
    && projectIncarnations.get(projectId) === projectIncarnation
    && frame.dataset.previewIncarnation === projectIncarnation
    && frame.isConnected === true
    && document.querySelector(
      `.project-row[data-project-id="${CSS.escape(projectId)}"] .project-detail-panel:not([hidden]) [data-preview-frame]`
    ) === frame;
  const announceFailure = () => {
    if (!isCurrentLoad() || previewLoadOutcome === 'success') {
      return;
    }
    previewLoadOutcome = 'failure';
    const key = `${projectIncarnation}:${generation}`;
    if (announcedPreviewFailures.get(projectId) === key) {
      return;
    }
    const project = (state.projects || []).find((item) => String(item.id) === projectId);
    if (!project) {
      return;
    }
    const status = document.getElementById('project-lifecycle-status');
    if (status) {
      status.textContent = `${String(project.name || 'Project')}: Preview unavailable. Open it in a browser to view it.`;
    }
    announcedPreviewFailures.set(projectId, key);
  };
  const onTimeout = () => {
    if (!isCurrentLoad()) {
      return;
    }
    previewLoadTimer = undefined;
    activePreviewLoad.timer = undefined;
    loading.hidden = true;
    fallback.hidden = false;
    announceFailure();
  };
  const onLoad = () => {
    if (!isCurrentLoad() || previewLoadOutcome === 'success') {
      return;
    }
    previewLoadOutcome = 'success';
    clearTimeout(previewLoadTimer);
    previewLoadTimer = undefined;
    frame.removeEventListener?.('load', onLoad);
    frame.removeEventListener?.('error', onError);
    activePreviewLoad = undefined;
    const project = (state.projects || []).find((item) => String(item.id) === projectId);
    const status = document.getElementById('project-lifecycle-status');
    const failureAnnouncement = project
      ? `${String(project.name || 'Project')}: Preview unavailable. Open it in a browser to view it.`
      : '';
    if (status && status.textContent === failureAnnouncement) {
      status.textContent = '';
    }
    announcedPreviewFailures.delete(projectId);
    wrapper.classList.add('loaded');
    loading.hidden = true;
    fallback.hidden = true;
  };
  const onError = () => {
    if (!isCurrentLoad() || previewLoadOutcome === 'success') {
      return;
    }
    clearTimeout(previewLoadTimer);
    previewLoadTimer = undefined;
    activePreviewLoad.timer = undefined;
    loading.hidden = true;
    fallback.hidden = false;
    announceFailure();
  };
  previewLoadTimer = setTimeout(onTimeout, 8000);
  activePreviewLoad = {
    frame,
    generation,
    onLoad,
    onError,
    timer: previewLoadTimer
  };
  frame.addEventListener('load', onLoad, { once: true });
  frame.addEventListener('error', onError, { once: true });
  frame.src = source;
}

function refreshProjectPreview(id) {
  const frame = document.querySelector(`.project-row[data-project-id="${CSS.escape(id)}"] [data-preview-frame]`);
  if (frame) {
    delete frame.dataset.loadedSource;
    loadProjectPreview(frame);
  }
}

function initializeProjectPreview() {
  document.querySelectorAll('.project-detail-panel:not([hidden]) [data-preview-frame]')
    .forEach(loadProjectPreview);
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
  document.querySelectorAll('[data-row-elapsed]').forEach((element) => {
    const startedAt = Number(element.dataset.startedAt);
    if (!Number.isFinite(startedAt)) {
      return;
    }
    const label = formatElapsed(Date.now() - startedAt);
    element.textContent = label;
    element.setAttribute('aria-label', `Running for ${label}`);
  });
}

function initializeTimelineClock() {
  clearInterval(timelineClock);
  timelineClock = undefined;
  const elapsed = document.querySelector('[data-timeline-elapsed], [data-row-elapsed]');
  if (!elapsed) {
    return;
  }
  updateTimelineElapsed();
  if (document.querySelector('[data-timeline-elapsed][data-ready-at=""], [data-row-elapsed]')) {
    timelineClock = setInterval(updateTimelineElapsed, 1000);
  }
}

const hostMessageHandlers = {
  projectMetrics: (message) => {
    const project = state.projects.find((item) => String(item.id) === String(message.id));
    if (project) {
      project.resourceMetrics = message.metrics;
      project.runtimePulse = message.runtimePulse;
      project.httpResponsePulse = message.httpResponsePulse;
    }
    const metrics = document.querySelector(`[data-resource-metrics][data-project-id="${CSS.escape(String(message.id || ''))}"]`);
    if (metrics) {
      metrics.innerHTML = resourceMetricsContent(
        message.metrics,
        message.runtimePulse,
        message.httpResponsePulse
      );
      metrics.setAttribute(
        'aria-label',
        resourceMetricsLabel(message.metrics, message.httpResponsePulse)
      );
    }
  },
  projectHttpPulse: (message) => {
    const project = state.projects.find((item) => String(item.id) === String(message.id));
    const metrics = document.querySelector(`[data-resource-metrics][data-project-id="${CSS.escape(String(message.id || ''))}"]`);
    if (project && metrics) {
      project.httpResponsePulse = message.httpResponsePulse;
      metrics.innerHTML = resourceMetricsContent(
        project.resourceMetrics,
        project.runtimePulse,
        project.httpResponsePulse
      );
      metrics.setAttribute(
        'aria-label',
        resourceMetricsLabel(project.resourceMetrics, project.httpResponsePulse)
      );
    }
  },
  projectOutputPeek: (message) => updateProjectOutputPeek(
    message.id,
    message.entries,
    message.projectIncarnation
  ),
  diagnosisRequestCopied: () => {
    const status = document.getElementById('diagnosis-copy-status');
    if (status) {
      status.textContent = 'Diagnosis request copied. Paste it into your agent chat.';
    }
  },
  diagnosisRequestSent: () => {
    if (state.mode === 'output' && state.projectOutput?.agentHandoffNotice) {
      renderProjectOutput();
    }
  },
  projectOutput: (message) => {
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
      failure.innerHTML = outputFailureSummaryHtml(message.failureSummary);
    }
    outputPanel.dataset.empty = String(!message.output);
    output.innerHTML = outputEntriesHtml(message.entries, message.failureSummary);
    const copyButton = document.querySelector('.output-copy-button');
    if (copyButton) {
      copyButton.disabled = !message.output;
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
  },
  outputCopied: () => {
    const copyButton = document.querySelector('.output-copy-button');
    if (!copyButton) {
      return;
    }
    copyButton.textContent = 'Copied';
    setTimeout(() => {
      copyButton.textContent = 'Copy output';
    }, 1500);
  },
  restoreProjectMenuFocus: (message) => {
    closeMenus();
    document.querySelector(`.more-button[data-id="${CSS.escape(message.id)}"]`)?.focus();
  }
};

window.addEventListener('message', createWebviewMessageRouter({
  handlers: hostMessageHandlers,
  messageToken: state.messageToken
}));

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

function updateProjectOutputPeek(id, entries, projectIncarnation) {
  const key = String(id || '');
  if (projectIncarnations.get(key) !== projectIncarnation) {
    return;
  }
  const slot = document.querySelector(`[data-output-peek-slot][data-project-id="${CSS.escape(key)}"]`);
  if (!slot) {
    pendingOutputPeeks.delete(key);
    return;
  }
  if (outputPeekInteractionActive(slot)) {
    pendingOutputPeeks.set(key, {
      entries: entries || [],
      projectIncarnation
    });
    return;
  }
  pendingOutputPeeks.delete(key);
  slot.innerHTML = projectOutputPeekHtml(entries || [], key, slot.dataset.projectName || 'project');
}

function flushPendingOutputPeeks() {
  for (const [id, pending] of [...pendingOutputPeeks]) {
    const currentIncarnation = projectIncarnations.get(id);
    if (!pending
      || typeof pending.projectIncarnation !== 'string'
      || pending.projectIncarnation !== currentIncarnation) {
      pendingOutputPeeks.delete(id);
      continue;
    }
    updateProjectOutputPeek(id, pending.entries, pending.projectIncarnation);
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
  if (event.target.id === 'launch-profile-select') {
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

app.addEventListener('change', (event) => {
  if (event.target.matches('[data-service-health-mode]')) {
    const draft = currentDraft(event.target.form);
    updateLaunchProfileDraft(draft, event.target.id);
    return;
  }
  if (event.target.id !== 'launch-profile-select') {
    return;
  }
  const previousId = String(
    state.draft.editingLaunchProfileId
    || state.draft.selectedLaunchProfileId
    || 'default'
  );
  const draft = currentDraft(event.target.form, previousId);
  draft.selectedLaunchProfileId = event.target.value;
  draft.editingLaunchProfileId = event.target.value;
  updateLaunchProfileDraft(draft, 'start-command');
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
      agent: element.dataset.agent,
      tab: element.dataset.tab,
      port: element.dataset.port
    };
  }
  if (target) {
    vscode.postMessage({ type: 'setFocusTarget', target });
  }
});

function handleSearchInput(event) {
  const query = String(event.currentTarget.value || '');
  searchQuery = query;
  publishFilterState('setSearchQuery', event.currentTarget);
  closeMenus();
  applyProjectFilter(query);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && tagsExpanded
    && event.target.closest('.project-tag-filter')) {
    event.preventDefault();
    tagsExpanded = false;
    saveWebviewState();
    renderList();
    requestAnimationFrame(() => document.querySelector('[data-action="toggle-tag-filter"]')?.focus());
    return;
  }
  if (event.key === 'Escape' && groupsExpanded
    && event.target.closest('.project-group-filter')) {
    event.preventDefault();
    groupsExpanded = false;
    saveWebviewState();
    renderList();
    requestAnimationFrame(() => document.querySelector('[data-action="toggle-group-filter"]')?.focus());
    return;
  }
  const tab = event.target.closest('[role="tab"]');
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
    event.preventDefault();
    selectProjectDetailTab(tabs[nextIndex].dataset.id, tabs[nextIndex].dataset.tab, true);
  }

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
    const trigger = document.querySelector('.menu-trigger[aria-expanded="true"]');
    closeMenus();
    trigger?.focus();
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.action-menu, .menu-trigger')) {
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
    const trigger = document.querySelector(`.menu-trigger[data-menu-target="${CSS.escape(openMenu.dataset.menuId)}"]`);
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
    menu.classList.remove('open-left');
    const trigger = document.querySelector(`.menu-trigger[data-menu-target="${CSS.escape(menu.dataset.menuId)}"]`);
    trigger?.setAttribute('aria-expanded', String(isOpenMenu));
  });
}

function toggleMenu(button) {
  const menuId = button.dataset.menuTarget || button.dataset.id;
  const menu = document.querySelector(`.action-menu[data-menu-id="${CSS.escape(menuId)}"]`);
  const shouldOpen = menu?.hidden;
  closeMenus(shouldOpen ? menuId : undefined);
  if (!shouldOpen) {
    return;
  }

  requestAnimationFrame(() => {
    const menuBounds = menu.getBoundingClientRect();
    if (menuBounds.bottom > window.innerHeight - 8) {
      menu.classList.add('open-up');
    }
    if (menuBounds.right > window.innerWidth - 8) {
      menu.classList.add('open-left');
    }
    menu.querySelector('button:not(:disabled)')?.focus();
  });
}

function applyInitialFocus() {
  const target = state.focusTarget;
  if (!target) {
    return;
  }
  if (target.type === 'field'
    && target.id === 'project-search'
    && state.filterRevisionSeen === true
    && state.searchFocused !== true) {
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
    if (target.action === 'focus-phone-handoff' && target.id) {
      element = document.getElementById(`phone-handoff-${String(target.id)}`);
    } else {
      let selector = `[data-action="${CSS.escape(target.action)}"]`;
      if (target.id) {
        selector += `[data-id="${CSS.escape(target.id)}"]`;
      }
      if (target.agent) {
        selector += `[data-agent="${CSS.escape(target.agent)}"]`;
      }
      if (target.tab) {
        selector += `[data-tab="${CSS.escape(target.tab)}"]`;
      }
      if (target.port) {
        selector += `[data-port="${CSS.escape(target.port)}"]`;
      }
      element = document.querySelector(selector);
    }
  }
  const hiddenMenu = element?.closest('.action-menu[hidden]');
  if (hiddenMenu) {
    element = document.querySelector(
      `.menu-trigger[data-menu-target="${CSS.escape(hiddenMenu.dataset.menuId)}"]`
    );
  }
  requestAnimationFrame(() => {
    element?.focus();
    if (target.caret === 'end'
      && element
      && typeof element.value === 'string'
      && typeof element.setSelectionRange === 'function') {
      const length = element.value.length;
      element.setSelectionRange(length, length);
    }
  });
}

if (state.mode === 'list') {
  renderList();
} else if (state.mode === 'agents') {
  renderAgentSetup();
} else if (state.mode === 'output') {
  renderProjectOutput();
  } else if (state.mode === 'diagnosis') {
  renderProjectDiagnosis();
  } else if (state.mode === 'port-listening') {
  renderPortListening();
  } else if (state.mode === 'port-resolve') {
  renderPortResolve();
  } else if (state.mode === 'run-groups') {
  renderRunGroupsEditor();
  } else if (state.mode === 'stack-review') {
  renderStackReview();
  } else if (state.mode === 'compose-import') {
  renderComposeImport();
  } else {
  renderProjectForm(state.mode);
}

applyInitialFocus();
