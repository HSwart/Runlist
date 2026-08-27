const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canUseCurrentWorkspace,
  currentWorkspaceFolderPath,
  foldersReferToSamePath,
  localWorkspaceFolders,
  orderSidebarProjects,
  projectForCurrentWindow,
  projectLastStartedAt,
  resolveWorkspaceFolderPath,
  selectCurrentWorkspaceFolder,
  startThisFolderDecision,
  starterDraftForCurrentWorkspace,
  workspaceFolderChoices,
  workspaceFolderMatchesProject
} = require('../src/projects/project-workspace');

function workspaceFolder(name, fsPath, scheme = 'file') {
  return { name, uri: { fsPath, scheme } };
}

test('offers the current workspace action only when a local folder is open', () => {
  assert.equal(canUseCurrentWorkspace(undefined), false);
  assert.equal(canUseCurrentWorkspace([]), false);
  assert.equal(canUseCurrentWorkspace([
    workspaceFolder('Remote app', '/workspaces/app', 'vscode-remote')
  ]), false);
  assert.equal(canUseCurrentWorkspace([
    workspaceFolder('Local app', '/Users/example/Local app')
  ]), true);
});

test('filters workspace roots to usable local folders', () => {
  const localFolder = workspaceFolder('Local app', '/Users/example/Local app');
  assert.deepEqual(localWorkspaceFolders([
    localFolder,
    workspaceFolder('Remote app', '/workspaces/app', 'vscode-remote'),
    { name: 'Missing URI' }
  ]), [localFolder]);
});

test('uses the only local workspace folder directly and preserves its platform path', async () => {
  let quickPickCalls = 0;
  const vscode = {
    workspace: {
      workspaceFolders: [workspaceFolder(
        'Windows app',
        'C:\\Users\\Example User\\Git Projects\\my-app'
      )]
    },
    window: {
      showQuickPick: async () => {
        quickPickCalls += 1;
      }
    }
  };

  assert.equal(
    await selectCurrentWorkspaceFolder(vscode),
    'C:\\Users\\Example User\\Git Projects\\my-app'
  );
  assert.equal(quickPickCalls, 0);
});

test('asks the user to choose from clearly labeled multi-root workspace folders', async () => {
  const workspaceFolders = [
    workspaceFolder('Frontend', '/Users/example/product/frontend'),
    workspaceFolder('API', '/Users/example/product/api')
  ];
  assert.deepEqual(workspaceFolderChoices(workspaceFolders), [
    { name: 'Frontend', folder: '/Users/example/product/frontend' },
    { name: 'API', folder: '/Users/example/product/api' }
  ]);
  assert.equal(
    resolveWorkspaceFolderPath(workspaceFolders, '/Users/example/product/api'),
    '/Users/example/product/api'
  );
  assert.equal(resolveWorkspaceFolderPath(workspaceFolders), undefined);

  const vscode = {
    workspace: { workspaceFolders },
    window: {
      showQuickPick: async () => assert.fail('multi-root choice belongs in the sidebar')
    }
  };
  assert.equal(await selectCurrentWorkspaceFolder(vscode), undefined);
  assert.equal(
    await selectCurrentWorkspaceFolder(vscode, { preferredFolder: '/Users/example/product/frontend' }),
    '/Users/example/product/frontend'
  );
});

test('prefills a starter draft only for a single local workspace folder', () => {
  assert.deepEqual(starterDraftForCurrentWorkspace([]), {});
  assert.deepEqual(starterDraftForCurrentWorkspace([
    workspaceFolder('Remote app', '/workspaces/app', 'vscode-remote'),
    workspaceFolder('Local app', '/Users/example/app')
  ]), { folder: '/Users/example/app' });
  assert.deepEqual(starterDraftForCurrentWorkspace([
    workspaceFolder('Frontend', '/Users/example/frontend'),
    workspaceFolder('API', '/Users/example/api')
  ]), {});
  assert.equal(
    currentWorkspaceFolderPath([workspaceFolder('App', '/Users/example/app')]),
    '/Users/example/app'
  );
});

test('matches project folders to the current window without requiring the path to exist', () => {
  assert.equal(foldersReferToSamePath(
    'C:\\Users\\Example\\App\\',
    'c:/Users/Example/App',
    'win32'
  ), true);
  assert.equal(foldersReferToSamePath('/Users/example/app', '/Users/example/other', 'darwin'), false);
  assert.equal(workspaceFolderMatchesProject(
    '/Users/example/app',
    [workspaceFolder('App', '/Users/example/app/')]
  ), true);
  assert.equal(workspaceFolderMatchesProject(
    '/Users/example/app',
    [workspaceFolder('Remote', '/workspaces/app', 'vscode-remote')]
  ), false);
});

test('keeps pinned projects first and sorts unpinned by last-started', () => {
  const ordered = orderSidebarProjects([
    { id: 'a', pinned: false, startupHistory: [{ completedAt: 1000, durationMs: 100 }] },
    { id: 'b', pinned: true, startupHistory: [{ completedAt: 500, durationMs: 50 }] },
    { id: 'c', pinned: false, timeline: { launchedAt: 3000 } },
    { id: 'd', pinned: true, currentWorkspace: true },
    { id: 'e', pinned: false, startupHistory: [{ completedAt: 2000, durationMs: 200 }] },
    { id: 'f', pinned: false }
  ]);
  assert.deepEqual(ordered.map((project) => project.id), ['b', 'd', 'c', 'e', 'a', 'f']);
});

test('start-then-stop-before-ready still sorts by the accepted start timestamp', () => {
  // Service-backed start accepted, then Stop before ready/timeout/fail:
  // no startupHistory entry and live timeline metadata is gone.
  // Persisted lastStartedAt must still win the unpinned sort.
  const ordered = orderSidebarProjects([
    {
      id: 'older-ready',
      pinned: false,
      startupHistory: [{ outcome: 'ready', completedAt: 5_000, durationMs: 1_000 }]
    },
    {
      id: 'stopped-before-ready',
      pinned: false,
      lastStartedAt: 9_000,
      startupHistory: []
    },
    {
      id: 'never-started',
      pinned: false
    }
  ]);
  assert.deepEqual(
    ordered.map((project) => project.id),
    ['stopped-before-ready', 'older-ready', 'never-started']
  );
  assert.equal(
    projectLastStartedAt({ lastStartedAt: 9_000, startupHistory: [] }),
    9_000
  );
  assert.equal(
    projectLastStartedAt({
      lastStartedAt: 2_000,
      timeline: { launchedAt: 8_000 },
      startupHistory: [{ outcome: 'ready', completedAt: 5_000, durationMs: 1_000 }]
    }),
    8_000
  );
});

test('keeps stable unpinned order when nothing has started yet', () => {
  const ordered = orderSidebarProjects([
    { id: 'a', pinned: false },
    { id: 'b', pinned: false, currentWorkspace: true },
    { id: 'c', pinned: false }
  ]);
  assert.deepEqual(ordered.map((project) => project.id), ['a', 'b', 'c']);
});

test('Start This Folder names a missing folder or unsaved project instead of starting', () => {
  assert.deepEqual(startThisFolderDecision([], []), {
    status: 'no-folder',
    message: 'Open a local folder in this window to use Start This Folder.'
  });
  assert.deepEqual(startThisFolderDecision([], [
    workspaceFolder('Remote', '/workspaces/app', 'vscode-remote')
  ]), {
    status: 'no-folder',
    message: 'Open a local folder in this window to use Start This Folder.'
  });
  assert.deepEqual(startThisFolderDecision([
    { id: 'other', folder: '/Users/example/other' }
  ], [
    workspaceFolder('App', '/Users/example/app')
  ]), {
    status: 'no-project',
    message: "This window's folder is not a saved Runlist project. Add it from Runlist first."
  });
});

test('Start This Folder picks the This-window project already sorted to the top', () => {
  const workspace = [workspaceFolder('App', '/Users/example/app')];
  const projects = [
    { id: 'other', folder: '/Users/example/other' },
    { id: 'unpinned-match', folder: '/Users/example/app', pinned: false },
    { id: 'pinned-match', folder: '/Users/example/app/', pinned: true }
  ];

  assert.equal(projectForCurrentWindow(projects, workspace).id, 'pinned-match');
  assert.deepEqual(startThisFolderDecision(projects, workspace), {
    status: 'start',
    projectId: 'pinned-match'
  });
  assert.equal(projectForCurrentWindow([
    { id: 'first', folder: '/Users/example/app' },
    { id: 'second', folder: '/Users/example/app/' }
  ], workspace).id, 'first');
});

test('returns no folder when none is open or a multi-root choice is cancelled', async () => {
  const emptyVscode = {
    workspace: {},
    window: { showQuickPick: async () => assert.fail('picker should not open') }
  };
  assert.equal(await selectCurrentWorkspaceFolder(emptyVscode), undefined);

  const multiRootVscode = {
    workspace: {
      workspaceFolders: [
        workspaceFolder('One', '/workspace/one'),
        workspaceFolder('Two', '/workspace/two')
      ]
    },
    window: { showQuickPick: async () => undefined }
  };
  assert.equal(await selectCurrentWorkspaceFolder(multiRootVscode), undefined);
});
