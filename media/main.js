const vscode = acquireVsCodeApi();
const state = window.switchboardState;
const app = document.getElementById('app');
let searchQuery = String(state.searchQuery || '');

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

function outputMessageHtml(value) {
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  let html = '';
  let previousIndex = 0;
  for (const match of String(value || '').matchAll(urlPattern)) {
    html += escapeHtml(String(value).slice(previousIndex, match.index));
    html += `<span class="output-url">${escapeHtml(match[0])}</span>`;
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
  const paths = {
    close: '<path d="M5 5l10 10M15 5 5 15"/>',
    edit: '<path d="M12.8 3.8a2 2 0 0 1 2.8 2.8L7 15.2 3 16l.8-4 9-8.2Z"/><path d="m11.5 5.1 3.4 3.4"/>',
    external: '<path d="M11 4h5v5M9 11l7-7"/><path d="M14 11v5H4V6h5"/>',
    folder: '<path d="M2.5 5.5h5l1.5 2h8.5v8.5h-15z"/>',
    more: '<circle cx="4" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1" fill="currentColor" stroke="none"/>',
    search: '<circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/>',
    terminal: '<path d="m3.5 5 4 4-4 4M9.5 13h6"/>',
    trash: '<path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11M9 9v5M11 9v5"/>'
  };
  return `<svg class="${className}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function renderList() {
  const runningCount = state.projects.filter((project) => ['running', 'starting', 'active'].includes(project.status)).length;
  const portConflictCount = state.projects.filter((project) => project.status === 'port-in-use').length;
  const stoppedCount = state.projects.filter((project) => project.status === 'stopped').length;

  if (state.projects.length === 0) {
    app.innerHTML = `
      <section class="empty-state">
        <span class="empty-mark" aria-hidden="true"></span>
        <h2>No projects yet</h2>
        <p>Save a project folder and its commands once, then start it from here.</p>
        <button class="primary-button" data-action="show-add">Add project</button>
      </section>`;
    return;
  }

  app.innerHTML = `
    <header class="summary" aria-label="Project status summary">
      <span id="project-count"><strong>${state.projects.length}</strong> ${state.projects.length === 1 ? 'project' : 'projects'}</span>
      <span id="summary-status" class="summary-status"><span class="status-dot ${runningCount ? 'running' : ''}"></span>${runningCount} running <span class="summary-separator" aria-hidden="true">·</span> ${stoppedCount} stopped${portConflictCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${portConflictCount} unavailable` : ''}</span>
    </header>
    ${state.stopAllCount > 1 ? `
      <div class="bulk-actions">
        <button class="stop-all-button" data-action="stop-all" aria-label="Stop all ${state.stopAllCount} running projects">
          <span class="action-icon square" aria-hidden="true"></span>
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
        const statusLabels = {
          running: 'Running',
          starting: 'Starting…',
          stopping: 'Stopping…',
          active: 'Active',
          'port-in-use': 'Port in use',
          stopped: 'Stopped'
        };
        const active = ['running', 'starting', 'active'].includes(projectStatus);
        const canOpen = ['running', 'active'].includes(projectStatus) && project.services?.length;
        const stopsProject = ['running', 'starting', 'active'].includes(projectStatus);
        const blocked = projectStatus === 'port-in-use';
        const action = stopsProject ? 'stop' : 'start';
        const actionLabel = blocked
          ? 'Unavailable'
          : projectStatus === 'stopping'
          ? 'Stopping…'
          : stopsProject
            ? 'Stop'
            : 'Start';
        const actionDisabled = projectStatus === 'stopping' || blocked;
        return `
          <article class="project-row" data-project-id="${projectId}" aria-labelledby="project-${projectId}">
            <div class="project-topline">
              <div class="project-heading">
                <h2 id="project-${projectId}">${projectName}</h2>
                <div class="project-status"><span class="status-dot ${active ? 'running' : projectStatus === 'port-in-use' ? 'conflict' : ''}"></span>${statusLabels[projectStatus]}</div>
              </div>
              <div class="project-actions">
                <button class="run-button ${blocked ? 'blocked' : stopsProject || projectStatus === 'stopping' ? 'stop' : 'start'}" data-action="${action}" data-id="${projectId}" aria-label="${actionLabel} ${projectName}" ${actionDisabled ? 'disabled' : ''}>
                  ${blocked ? '' : `<span class="action-icon ${stopsProject || projectStatus === 'stopping' ? 'square' : 'triangle'}" aria-hidden="true"></span>`}
                  ${actionLabel}
                </button>
                <button class="more-button" data-action="toggle-menu" data-id="${projectId}" aria-label="More actions for ${projectName}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
                <div class="action-menu" data-menu-id="${projectId}" role="menu" aria-label="Actions for ${projectName}" hidden>
                  <button data-action="open" data-id="${projectId}" role="menuitem" ${canOpen ? '' : 'disabled'} title="${canOpen ? `Open ${projectName} in your browser` : projectStatus === 'port-in-use' ? 'This port may belong to another app' : `Start ${projectName} before opening it`}">
                    ${icon('external', 'menu-icon')}<span>Open app</span>
                  </button>
                  <button data-action="open-vscode" data-id="${projectId}" role="menuitem" title="Open ${projectName} in a new VS Code window">
                    ${icon('folder', 'menu-icon')}<span>Open in VS Code</span>
                  </button>
                  <button data-action="output" data-id="${projectId}" role="menuitem">
                    ${icon('terminal', 'menu-icon')}<span>View output</span>
                  </button>
                  <button data-action="edit" data-id="${projectId}" role="menuitem">
                    ${icon('edit', 'menu-icon')}<span>Edit project</span>
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
                ${icon('folder', 'detail-icon')}<span>${escapeHtml(project.folder)}</span>
              </div>
            </div>
            ${project.services?.length ? `
              <div class="project-services" aria-label="Service ports">
                ${project.services.map((service) => `<span><span class="service-indicator ${active ? 'running' : projectStatus === 'port-in-use' ? 'conflict' : ''}" aria-hidden="true"></span>${escapeHtml(service.name)} <strong>:${escapeHtml(String(service.port))}</strong></span>`).join('')}
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

  const visibleRunningCount = matchingProjects
    .filter((project) => ['running', 'starting', 'active'].includes(project.status)).length;
  const visibleStoppedCount = matchingProjects
    .filter((project) => project.status === 'stopped').length;
  const visibleConflictCount = matchingProjects
    .filter((project) => project.status === 'port-in-use').length;
  const summaryStatus = document.getElementById('summary-status');
  if (summaryStatus) {
    summaryStatus.innerHTML = `<span class="status-dot ${visibleRunningCount ? 'running' : ''}"></span>${visibleRunningCount} running <span class="summary-separator" aria-hidden="true">·</span> ${visibleStoppedCount} stopped${visibleConflictCount ? ` <span class="summary-separator" aria-hidden="true">·</span> ${visibleConflictCount} unavailable` : ''}`;
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
}

function renderProjectForm(mode) {
  const editing = mode === 'edit';
  app.innerHTML = `
    <section class="add-screen">
      <header class="screen-header">
        <h2>${editing ? 'Edit project' : 'Add project'}</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close ${editing ? 'edit' : 'add'} project screen">${icon('close')}</button>
      </header>
      <p class="screen-copy">${editing ? `Update ${escapeHtml(state.draft.name || 'this project')} and its saved commands.` : 'Choose a folder and save its commands once.'}</p>
      <form id="project-form">
        <label for="project-name">Project name <span class="optional-label">Optional</span></label>
        <input id="project-name" name="name" value="${escapeHtml(state.draft.name || '')}" placeholder="Defaults to folder name" maxlength="100">

        <label for="folder">Project folder</label>
        <div class="folder-control">
          <input id="folder" name="folder" value="${escapeHtml(state.draft.folder || '')}" placeholder="Choose a folder" required>
          <button class="browse-button" type="button" data-action="pick-folder">Browse</button>
        </div>

        <label for="start-command">Start command</label>
        <input id="start-command" name="startCommand" value="${escapeHtml(state.draft.startCommand || '')}" placeholder="npm run dev" required>

        <label for="stop-command">Stop command</label>
        <input id="stop-command" name="stopCommand" value="${escapeHtml(state.draft.stopCommand || '')}" placeholder="pkill -f vite" required>

        <label for="app-port">App port <span class="optional-label">Optional</span></label>
        <input id="app-port" name="appPort" type="number" min="1" max="65535" step="1" inputmode="numeric" value="${escapeHtml(String(state.draft.appPort ?? state.draft.services?.[0]?.port ?? ''))}" placeholder="3000">
        <p class="field-hint">Used to confirm the app is running and enable Open app.</p>

        <button class="primary-button save-button" type="submit">${editing ? 'Save changes' : 'Save project'}</button>
        <p class="form-hint">${editing ? 'Changes apply the next time you start this project.' : 'Commands run inside the selected folder.'}</p>
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
        </div>
        <button class="secondary-button agent-register-button" data-action="register-agent" data-agent="${id}" ${busy ? 'disabled aria-busy="true"' : ''} ${connection.message ? `aria-describedby="${messageId}"` : ''}>
          ${busy ? 'Registering…' : registered ? 'Refresh registration' : 'Register'}
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
      <p class="screen-copy">Let your coding agent add or update projects in Switchboard.</p>
      <div class="agent-list" aria-label="Supported coding agents">
        <article class="agent-card">
          <div class="agent-card-heading">
            <div>
              <h3>GitHub Copilot</h3>
              <p>Discovered automatically through VS Code.</p>
            </div>
            <span class="connection-label"><span class="status-dot running" aria-hidden="true"></span>Ready</span>
          </div>
        </article>
        ${agentCard('codex', 'Codex', 'Registers Switchboard in your global Codex MCP configuration.')}
        ${agentCard('claude', 'Claude Code', 'Registers Switchboard for every local Claude Code project.')}
      </div>
      <p class="agent-footnote">Agents can save project commands and explicit service ports. Starting and stopping projects stays in this sidebar.</p>
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
      <div class="output-panel" data-empty="${projectOutput.output ? 'false' : 'true'}" aria-live="polite">
        <div id="project-output">${outputEntriesHtml(projectOutput.entries)}</div>
      </div>
      <p class="output-hint">Output is kept for the latest run in this VS Code window.</p>
    </section>`;
  requestAnimationFrame(() => {
    const outputPanel = document.querySelector('.output-panel');
    if (outputPanel) {
      outputPanel.scrollTop = outputPanel.scrollHeight;
    }
  });
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

  const actions = {
    'show-add': () => vscode.postMessage({ type: 'showAdd' }),
    'close-screen': () => vscode.postMessage({ type: 'closeScreen' }),
    'pick-folder': () => vscode.postMessage({ type: 'pickFolder', draft: currentDraft() }),
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
    'copy-output': () => vscode.postMessage({ type: 'copyOutput' }),
    edit: () => vscode.postMessage({ type: 'showEdit', id: button.dataset.id }),
    delete: () => vscode.postMessage({ type: 'deleteProject', id: button.dataset.id }),
    start: () => vscode.postMessage({ type: 'startProject', id: button.dataset.id }),
    stop: () => vscode.postMessage({ type: 'stopProject', id: button.dataset.id }),
    'stop-all': () => {
      button.disabled = true;
      button.textContent = 'Stopping…';
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
  outputPanel.dataset.empty = String(!event.data.output);
  output.innerHTML = outputEntriesHtml(event.data.entries);
  const copyButton = document.querySelector('.output-copy-button');
  if (copyButton) {
    copyButton.disabled = !event.data.output;
  }
  outputPanel.scrollTop = outputPanel.scrollHeight;
});

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

app.addEventListener('submit', (event) => {
  if (event.target.id !== 'project-form') {
    return;
  }
  event.preventDefault();
  vscode.postMessage({ type: 'saveProject', project: currentDraft(event.target) });
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

if (state.mode === 'list') {
  renderList();
  document.getElementById('project-search')?.addEventListener('input', handleSearchInput);
} else if (state.mode === 'agents') {
  renderAgentSetup();
} else if (state.mode === 'output') {
  renderProjectOutput();
} else {
  renderProjectForm(state.mode);
}
