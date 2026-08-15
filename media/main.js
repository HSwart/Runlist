const vscode = acquireVsCodeApi();
const state = window.switchboardState;
const app = document.getElementById('app');
let searchQuery = String(state.searchQuery || '');
let outputFollowLatest = true;

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLocaleLowerCase();
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

function outputEntriesHtml(entries) {
  if (!entries?.length) {
    return '<p class="output-empty">No output yet. Start this project to see its output here.</p>';
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

function icon(name, className = 'icon') {
  // Official VS Code Codicon paths: https://github.com/microsoft/vscode-codicons
  const icons = {
    'arrow-down': { viewBox: '0 0 16 16', body: '<path d="M13.854 8.146C13.659 7.951 13.342 7.951 13.147 8.146L9.00096 12.292V2.5C9.00096 2.224 8.77696 2 8.50096 2C8.22496 2 8.00096 2.224 8.00096 2.5V12.293L3.85496 8.147C3.65996 7.952 3.34296 7.952 3.14796 8.147C2.95296 8.342 2.95296 8.659 3.14796 8.854L8.14796 13.854C8.24596 13.952 8.37396 14 8.50196 14C8.62996 14 8.75796 13.951 8.85596 13.854L13.856 8.854C14.051 8.659 14.051 8.342 13.856 8.147L13.854 8.146Z"/>' },
    close: { viewBox: '0 0 16 16', body: '<path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/>' },
    edit: { viewBox: '0 0 16 16', body: '<path d="M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z"/>' },
    external: { viewBox: '0 0 16 16', body: '<path d="M15 9.5V12.5C15 13.879 13.879 15 12.5 15H3.5C2.121 15 1 13.879 1 12.5V3.5C1 2.121 2.121 1 3.5 1H6.5C6.776 1 7 1.224 7 1.5C7 1.776 6.776 2 6.5 2H3.5C2.673 2 2 2.673 2 3.5V12.5C2 13.327 2.673 14 3.5 14H12.5C13.327 14 14 13.327 14 12.5V9.5C14 9.224 14.224 9 14.5 9C14.776 9 15 9.224 15 9.5ZM14.5 1H9.5C9.224 1 9 1.224 9 1.5C9 1.776 9.224 2 9.5 2H13.293L9.147 6.146C8.952 6.341 8.952 6.658 9.147 6.853C9.245 6.951 9.373 6.999 9.501 6.999C9.629 6.999 9.757 6.95 9.855 6.853L14.001 2.707V6.5C14.001 6.776 14.225 7 14.501 7C14.777 7 15.001 6.776 15.001 6.5V1.5C15.001 1.224 14.777 1 14.501 1H14.5Z"/>' },
    folder: { viewBox: '0 0 16 16', body: '<path d="M2 4.5V6H5.58579C5.71839 6 5.84557 5.94732 5.93934 5.85355L7.29289 4.5L5.93934 3.14645C5.84557 3.05268 5.71839 3 5.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM1 4.5C1 3.11929 2.11929 2 3.5 2H5.58579C5.98361 2 6.36514 2.15804 6.64645 2.43934L8.20711 4H12.5C13.8807 4 15 5.11929 15 6.5V11.5C15 12.8807 13.8807 14 12.5 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5ZM2 7V11.5C2 12.3284 2.67157 13 3.5 13H12.5C13.3284 13 14 12.3284 14 11.5V6.5C14 5.67157 13.3284 5 12.5 5H8.20711L6.64645 6.56066C6.36514 6.84197 5.98361 7 5.58579 7H2Z"/>' },
    loading: { viewBox: '0 0 16 16', body: '<path d="M13.5 8.5C13.224 8.5 13 8.276 13 8C13 5.243 10.757 3 8 3C5.243 3 3 5.243 3 8C3 8.276 2.776 8.5 2.5 8.5C2.224 8.5 2 8.276 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 8.276 13.776 8.5 13.5 8.5Z"/>' },
    more: { viewBox: '0 0 16 16', body: '<path d="M5 8C5 8.55229 4.55228 9 4 9C3.44772 9 3 8.55229 3 8C3 7.44772 3.44772 7 4 7C4.55228 7 5 7.44772 5 8ZM9 8C9 8.55229 8.55229 9 8 9C7.44772 9 7 8.55229 7 8C7 7.44772 7.44772 7 8 7C8.55229 7 9 7.44772 9 8ZM12 9C12.5523 9 13 8.55229 13 8C13 7.44772 12.5523 7 12 7C11.4477 7 11 7.44772 11 8C11 8.55229 11.4477 9 12 9Z"/>' },
    play: { viewBox: '0 0 16 16', body: '<path d="M4.74514 3.06414C4.41183 2.87665 4 3.11751 4 3.49993V12.5002C4 12.8826 4.41182 13.1235 4.74512 12.936L12.7454 8.43601C13.0852 8.24486 13.0852 7.75559 12.7454 7.56443L4.74514 3.06414ZM3 3.49993C3 2.35268 4.2355 1.63011 5.23541 2.19257L13.2357 6.69286C14.2551 7.26633 14.2551 8.73415 13.2356 9.30759L5.23537 13.8076C4.23546 14.37 3 13.6474 3 12.5002V3.49993Z"/>' },
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

function statusSummaryHtml(projects) {
  const reviewCount = projects.filter((project) => project.reviewRequired).length;
  const runningCount = projects
    .filter((project) => !project.reviewRequired
      && ['running', 'active'].includes(project.status)).length;
  const startingCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'starting').length;
  const stoppingCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'stopping').length;
  const stoppedCount = projects
    .filter((project) => !project.reviewRequired && project.status === 'stopped').length;
  const conflictCount = projects
    .filter((project) => !project.reviewRequired
      && ['port-in-use', 'port-in-use-unknown'].includes(project.status)).length;
  return `<span class="status-dot ${runningCount ? 'running' : ''}"></span>${runningCount} running${startingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${startingCount} starting` : ''}${stoppingCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${stoppingCount} stopping` : ''} <span class="summary-separator" aria-hidden="true">·</span> ${stoppedCount} stopped${reviewCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${reviewCount} to review` : ''}${conflictCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${conflictCount} unavailable` : ''}`;
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
    <section class="project-list" aria-label="Projects">
      ${state.projects.map((project) => {
        const projectId = escapeHtml(project.id);
        const projectName = escapeHtml(project.name);
        const projectStatus = project.status || 'stopped';
        const reviewRequired = Boolean(project.reviewRequired);
        const displayStatus = reviewRequired ? 'review-required' : projectStatus;
        const conflict = project.portConflict;
        const conflictOwnerName = escapeHtml(conflict?.ownerName || 'Another app');
        const conflictProjectNames = (conflict?.projectNames || []).map(escapeHtml).join(', ');
        const statusLabels = {
          running: 'Running',
          starting: 'Starting…',
          stopping: 'Stopping…',
          active: 'Detected running',
          'port-in-use': conflict?.ownerName ? `Port in use by ${conflictOwnerName}` : 'Port in use',
          'port-in-use-unknown': 'Port in use — owner unknown',
          'review-required': 'Review setup',
          stopped: 'Stopped'
        };
        const active = ['running', 'active'].includes(projectStatus);
        const conflicted = ['port-in-use', 'port-in-use-unknown'].includes(projectStatus);
        const transitioning = ['starting', 'stopping'].includes(projectStatus);
        const canOpen = ['running', 'active'].includes(projectStatus) && project.services?.length;
        const stopsProject = ['running', 'starting', 'active'].includes(projectStatus);
        const blocked = conflicted;
        const action = reviewRequired ? 'edit' : stopsProject ? 'stop' : 'start';
        const actionLabel = reviewRequired
          ? 'Review setup'
          : blocked
          ? 'Unavailable'
          : projectStatus === 'stopping'
          ? 'Stopping…'
          : stopsProject
            ? 'Stop'
            : 'Start';
        const actionTitle = reviewRequired
          ? `Review setup for ${projectName}`
          : projectStatus === 'port-in-use-unknown'
          ? `Port :${conflict?.port || 'unknown'} owner is unknown — cannot safely start or stop ${projectName}`
          : blocked
            ? `${conflictOwnerName} is using port :${conflict?.port || 'unknown'} — cannot start ${projectName}`
          : `${actionLabel} ${projectName}`;
        const statusTitle = reviewRequired
          ? 'A coding agent added or updated this setup. Review its folder and commands before running it.'
          : projectStatus === 'active'
          ? 'Detected through a configured service port; Switchboard did not start this process.'
          : projectStatus === 'port-in-use-unknown'
            ? `Port :${conflict?.port || 'unknown'} is shared with ${conflictProjectNames}. Switchboard cannot identify the running owner.`
            : projectStatus === 'port-in-use'
              ? `${conflictOwnerName} is using port :${conflict?.port || 'unknown'}.`
              : '';
        const actionDisabled = projectStatus === 'stopping' || blocked;
        return `
          <article class="project-row" data-project-id="${projectId}" aria-labelledby="project-${projectId}">
            <div class="project-topline">
              <div class="project-heading">
                <h2 id="project-${projectId}" class="auto-scroll" title="${projectName}"><span class="auto-scroll-content">${projectName}</span></h2>
                <div class="project-status status-${displayStatus}"${statusTitle ? ` title="${statusTitle}"` : ''}>${!reviewRequired && transitioning ? productIcon('loading', 'status-progress') : ''}<span class="auto-scroll"><span class="auto-scroll-content">${statusLabels[displayStatus]}</span></span></div>
              </div>
              <div class="project-actions">
                <button class="run-button ${reviewRequired ? 'review' : blocked ? 'blocked' : stopsProject || projectStatus === 'stopping' ? 'stop' : 'start'}" data-action="${action}" data-id="${projectId}" aria-label="${actionTitle}" title="${actionTitle}" ${actionDisabled && !reviewRequired ? 'disabled' : ''}>
                  ${reviewRequired ? icon('edit') : productIcon(stopsProject || projectStatus === 'stopping' ? 'stop' : 'play')}
                </button>
                <button class="more-button" data-action="toggle-menu" data-id="${projectId}" aria-label="More actions for ${projectName}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
                <div class="action-menu" data-menu-id="${projectId}" role="menu" aria-label="Actions for ${projectName}" hidden>
                  <button data-action="open" data-id="${projectId}" role="menuitem" ${canOpen ? '' : 'disabled'} title="${canOpen ? `Open ${projectName} in your browser` : conflicted ? 'This port may belong to another app' : `Start ${projectName} before opening it`}">
                    ${icon('external', 'menu-icon')}<span>Open app</span>
                  </button>
                  <button data-action="open-vscode" data-id="${projectId}" role="menuitem" title="Open ${projectName} in a new VS Code window">
                    ${icon('folder', 'menu-icon')}<span>Open in VS Code</span>
                  </button>
                  <button data-action="output" data-id="${projectId}" role="menuitem">
                    ${icon('terminal', 'menu-icon')}<span>View output</span>
                  </button>
                  <button data-action="edit" data-id="${projectId}" role="menuitem">
                    ${icon('edit', 'menu-icon')}<span>${reviewRequired ? 'Review setup' : 'Edit project'}</span>
                  </button>
                  <div class="menu-divider" role="separator"></div>
                  <button class="danger" data-action="delete" data-id="${projectId}" role="menuitem">
                    ${icon('trash', 'menu-icon')}<span>Delete project</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="project-details">
              <div class="detail-row" title="${escapeHtml(project.folder)}">
                ${icon('folder', 'detail-icon')}<span class="auto-scroll"><span class="auto-scroll-content">${escapeHtml(project.folder)}</span></span>
              </div>
            </div>
            ${project.services?.length ? `
              <div class="project-services" aria-label="Service ports">
                ${project.services.map((service) => `<span><span class="service-indicator ${active ? 'running' : conflicted ? 'conflict' : ''}" aria-hidden="true"></span>${escapeHtml(service.name)} <strong>:${escapeHtml(String(service.port))}</strong></span>`).join('')}
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

function sharedPortWarningText(draft) {
  const port = Number(draft?.appPort ?? draft?.services?.[0]?.port);
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
  const warning = document.getElementById('shared-port-warning');
  if (!warning) {
    return;
  }
  warning.textContent = sharedPortWarningText(draft);
  warning.hidden = !warning.textContent;
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
  const sharedPortWarning = sharedPortWarningText(state.draft);
  app.innerHTML = `
    <section class="add-screen">
      <header class="screen-header">
        <h2>${reviewing ? 'Review project setup' : editing ? 'Edit project' : 'Add project'}</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close ${reviewing ? 'review' : editing ? 'edit' : 'add'} project screen">${icon('close')}</button>
      </header>
      <p class="screen-copy">${reviewing ? 'A coding agent added or updated this setup. Check the folder and commands before approving them.' : editing ? `Update ${escapeHtml(state.draft.name || 'this project')} and its saved commands.` : 'Choose a folder and save its commands once.'}</p>
      <form id="project-form" novalidate>
        ${errors.form ? `<p id="form-error-summary" class="form-error-summary" role="alert" tabindex="-1">${escapeHtml(errors.form)}</p>` : ''}
        <label for="project-name">Project name <span class="optional-label">Optional</span></label>
        <input id="project-name" name="name" value="${escapeHtml(state.draft.name || '')}" placeholder="Defaults to folder name" maxlength="100" ${errorAttributes('project-name')}>
        ${fieldError('project-name')}

        <label for="folder">Project folder</label>
        <div class="folder-control">
          <input id="folder" name="folder" value="${escapeHtml(state.draft.folder || '')}" placeholder="Choose a folder" ${errorAttributes('folder')}>
          <div class="folder-actions">
            ${!editing && state.canUseCurrentWorkspace ? '<button class="folder-button" type="button" data-action="use-current-workspace">Use current workspace</button>' : ''}
            <button class="folder-button" type="button" data-action="pick-folder">Browse</button>
          </div>
        </div>
        ${fieldError('folder')}

        <label for="start-command">Start command</label>
        <input id="start-command" name="startCommand" value="${escapeHtml(state.draft.startCommand || '')}" placeholder="npm run dev" ${errorAttributes('start-command')}>
        ${fieldError('start-command')}

        <label for="stop-command">Stop command</label>
        <input id="stop-command" name="stopCommand" value="${escapeHtml(state.draft.stopCommand || '')}" placeholder="pkill -f vite" ${errorAttributes('stop-command')}>
        ${fieldError('stop-command')}

        <label for="app-port">App port <span class="optional-label">Optional</span></label>
        <input id="app-port" name="appPort" type="number" min="1" max="65535" step="1" inputmode="numeric" value="${escapeHtml(String(state.draft.appPort ?? state.draft.services?.[0]?.port ?? ''))}" placeholder="3000" ${errorAttributes('app-port')}>
        ${fieldError('app-port')}
        <p class="field-hint">Used to confirm the app is running and enable Open app.</p>
        <p id="shared-port-warning" class="shared-port-warning" role="status" ${sharedPortWarning ? '' : 'hidden'}>${escapeHtml(sharedPortWarning)}</p>

        ${reviewing && state.reviewServices?.length ? `
          <div class="review-services">
            <span>Configured services</span>
            ${state.reviewServices.map((service) => `<code>${escapeHtml(service.name)} :${escapeHtml(String(service.port))}</code>`).join('')}
          </div>` : ''}

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
      <p class="screen-copy">Connect Switchboard and add its guided project setup skill.</p>
      <div class="agent-list" aria-label="Supported coding agents">
        ${agentCard('copilot', 'GitHub Copilot', 'Adds /switchboard. The connection is discovered automatically through VS Code.')}
        ${agentCard('codex', 'Codex', 'Registers the connection and adds $switchboard.')}
        ${agentCard('claude', 'Claude Code', 'Registers the connection and adds /switchboard.')}
      </div>
      <p class="agent-footnote">The skill inspects exact project commands and service ports, then saves them through Switchboard.</p>
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
      <div class="output-panel-wrap">
        <div class="output-panel" data-empty="${projectOutput.output ? 'false' : 'true'}" tabindex="0" aria-label="Recent output for ${escapeHtml(projectOutput.name)}">
          <div id="project-output">${outputEntriesHtml(projectOutput.entries)}</div>
        </div>
        <button class="output-jump-button" data-action="jump-latest" hidden>
          ${icon('arrow-down', 'jump-icon')}Latest
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
    appPort: fieldValue('appPort')
  };
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
    'use-current-workspace': () => vscode.postMessage({
      type: 'useCurrentWorkspace',
      draft: currentDraft()
    }),
    'register-agent': () => vscode.postMessage({ type: 'registerAgent', agent: button.dataset.agent }),
    'toggle-menu': () => toggleMenu(button),
    open: () => {
      closeMenus();
      vscode.postMessage({ type: 'openProject', id: button.dataset.id });
    },
    'open-vscode': () => {
      closeMenus();
      vscode.postMessage({ type: 'openProjectFolder', id: button.dataset.id });
    },
    output: () => {
      closeMenus();
      vscode.postMessage({ type: 'showOutput', id: button.dataset.id });
    },
    'open-output-url': () => {
      event.preventDefault();
      vscode.postMessage({ type: 'openOutputUrl', url: button.dataset.url });
    },
    'jump-latest': jumpToLatestOutput,
    'copy-output': () => vscode.postMessage({ type: 'copyOutput' }),
    edit: () => vscode.postMessage({ type: 'showEdit', id: button.dataset.id }),
    delete: () => vscode.postMessage({ type: 'deleteProject', id: button.dataset.id }),
    start: () => vscode.postMessage({ type: 'startProject', id: button.dataset.id }),
    stop: () => vscode.postMessage({ type: 'stopProject', id: button.dataset.id }),
    'stop-all': () => {
      button.disabled = true;
      button.innerHTML = `${productIcon('loading', 'status-progress')}Stopping all…`;
      vscode.postMessage({ type: 'stopAllProjects' });
    }
  };

  actions[button.dataset.action]?.();
});

window.addEventListener('message', (event) => {
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
  outputPanel.dataset.empty = String(!event.data.output);
  output.innerHTML = outputEntriesHtml(event.data.entries);
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
  if (event.data?.type !== 'outputCopied') {
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
  if (event.data?.type !== 'restoreProjectMenuFocus') {
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
  delete state.formErrors?.[field];
  event.target.setAttribute('aria-invalid', 'false');
  event.target.removeAttribute('aria-describedby');
  document.getElementById(`${field}-error`)?.remove();
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
} else if (state.mode === 'agents') {
  renderAgentSetup();
} else if (state.mode === 'output') {
  renderProjectOutput();
} else {
  renderProjectForm(state.mode);
}

applyInitialFocus();
