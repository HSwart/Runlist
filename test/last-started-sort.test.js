const assert = require('node:assert/strict');
const test = require('node:test');
const {
  orderSidebarProjects,
  projectLastStartedAt
} = require('../src/projects/project-workspace');

test('projectLastStartedAt prefers the newest timeline or history start', () => {
  assert.equal(projectLastStartedAt({}), 0);
  assert.equal(projectLastStartedAt({
    timeline: { launchedAt: 4000 },
    startupHistory: [{ completedAt: 3000, durationMs: 500 }]
  }), 4000);
  assert.equal(projectLastStartedAt({
    startupHistory: [
      { completedAt: 2000, durationMs: 200 },
      { completedAt: 5000, durationMs: 1000 }
    ]
  }), 4000);
});

test('unpinned sidebar rows sort by last-started without a sort control', () => {
  const ordered = orderSidebarProjects([
    { id: 'old', pinned: false, startupHistory: [{ completedAt: 2000, durationMs: 100 }] },
    { id: 'pinned', pinned: true, startupHistory: [{ completedAt: 9000, durationMs: 100 }] },
    { id: 'new', pinned: false, timeline: { launchedAt: 8000 } },
    { id: 'never', pinned: false }
  ]);

  assert.deepEqual(ordered.map((project) => project.id), ['pinned', 'new', 'old', 'never']);
});
