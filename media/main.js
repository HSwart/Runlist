const vscode = acquireVsCodeApi();
const state = window.porterState;
const app = document.getElementById('app');

function escapeHtml(value = '') {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderList() {
  const runningCount = state.projects.filter((project) => project.running).length;
  const stoppedCount = state.projects.length - runningCount;

  if (state.projects.length === 0) {
    app.innerHTML = `
      <section class="empty-state">
        <span class="empty-mark" aria-hidden="true"></span>
        <h2>No projects yet</h2>
        <p>Save a project folder and its start and stop commands.</p>
        <button class="primary-button" data-action="show-add">Add project</button>
      </section>`;
    return;
  }

  app.innerHTML = `
    <div class="summary"><span class="status-dot running"></span>${runningCount} running <span aria-hidden="true">·</span> ${stoppedCount} stopped</div>
    <section class="project-list" aria-label="Projects">
      ${state.projects.map((project) => `
        <article class="project-row">
          <div class="project-topline">
            <div class="project-heading">
              <h2>${escapeHtml(project.name)}</h2>
              <div class="project-status"><span class="status-dot ${project.running ? 'running' : ''}"></span>${project.running ? 'Running' : 'Stopped'}</div>
            </div>
            <div class="project-actions">
              <button class="run-button ${project.running ? 'stop' : 'start'}" data-action="${project.running ? 'stop' : 'start'}" data-id="${escapeHtml(project.id)}">
                <span class="action-icon ${project.running ? 'square' : 'triangle'}" aria-hidden="true"></span>
                ${project.running ? 'Stop' : 'Start'}
              </button>
              <button class="more-button" data-action="toggle-menu" data-id="${escapeHtml(project.id)}" aria-label="More actions for ${escapeHtml(project.name)}" aria-haspopup="menu" aria-expanded="false">…</button>
              <div class="action-menu" data-menu-id="${escapeHtml(project.id)}" role="menu" hidden>
                <button data-action="edit" data-id="${escapeHtml(project.id)}" role="menuitem">Edit project</button>
                <div class="menu-divider" role="separator"></div>
                <button class="danger" data-action="delete" data-id="${escapeHtml(project.id)}" role="menuitem">Delete project</button>
              </div>
            </div>
          </div>
          <div class="project-command">
            <span title="${escapeHtml(project.folder)}">${escapeHtml(project.folder)}</span>
            <strong>${escapeHtml(project.startCommand)}</strong>
          </div>
        </article>`).join('')}
    </section>`;
}

function renderProjectForm(mode) {
  const editing = mode === 'edit';
  app.innerHTML = `
    <section class="add-screen">
      <header class="screen-header">
        <h2>${editing ? 'Edit project' : 'Add project'}</h2>
        <button class="icon-button" data-action="close-screen" aria-label="Close ${editing ? 'edit' : 'add'} project screen">×</button>
      </header>
      <p class="screen-copy">${editing ? `Update ${escapeHtml(state.draft.name || 'this project')} and its saved commands.` : 'Choose a folder and save its commands once.'}</p>
      <form id="project-form">
        <label for="folder">Project folder</label>
        <div class="folder-control">
          <input id="folder" name="folder" value="${escapeHtml(state.draft.folder || '')}" placeholder="Choose a folder" required>
          <button class="browse-button" type="button" data-action="pick-folder">Browse</button>
        </div>

        <label for="start-command">Start command</label>
        <input id="start-command" name="startCommand" value="${escapeHtml(state.draft.startCommand || '')}" placeholder="npm run dev" required>

        <label for="stop-command">Stop command</label>
        <input id="stop-command" name="stopCommand" value="${escapeHtml(state.draft.stopCommand || '')}" placeholder="pkill -f vite" required>

        <button class="primary-button save-button" type="submit">${editing ? 'Save changes' : 'Save project'}</button>
        <p class="form-hint">${editing ? 'Changes apply the next time you start this project.' : 'Commands run inside the selected folder.'}</p>
      </form>
    </section>`;
}

function currentDraft() {
  return {
    folder: document.getElementById('folder')?.value || '',
    startCommand: document.getElementById('start-command')?.value || '',
    stopCommand: document.getElementById('stop-command')?.value || ''
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
    'toggle-menu': () => toggleMenu(button),
    edit: () => vscode.postMessage({ type: 'showEdit', id: button.dataset.id }),
    delete: () => vscode.postMessage({ type: 'deleteProject', id: button.dataset.id }),
    start: () => vscode.postMessage({ type: 'startProject', id: button.dataset.id }),
    stop: () => vscode.postMessage({ type: 'stopProject', id: button.dataset.id })
  };

  actions[button.dataset.action]?.();
});

app.addEventListener('submit', (event) => {
  if (event.target.id !== 'project-form') {
    return;
  }
  event.preventDefault();
  vscode.postMessage({ type: 'saveProject', project: currentDraft() });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenus();
  }
});

function closeMenus(exceptId) {
  document.querySelectorAll('.action-menu').forEach((menu) => {
    const isOpenMenu = menu.dataset.menuId === exceptId;
    menu.hidden = !isOpenMenu;
    const trigger = document.querySelector(`.more-button[data-id="${CSS.escape(menu.dataset.menuId)}"]`);
    trigger?.setAttribute('aria-expanded', String(isOpenMenu));
  });
}

function toggleMenu(button) {
  const menu = document.querySelector(`.action-menu[data-menu-id="${CSS.escape(button.dataset.id)}"]`);
  const shouldOpen = menu?.hidden;
  closeMenus(shouldOpen ? button.dataset.id : undefined);
}

state.mode === 'list' ? renderList() : renderProjectForm(state.mode);
