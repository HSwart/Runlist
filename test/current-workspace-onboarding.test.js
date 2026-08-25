const assert = require('node:assert/strict');
const test = require('node:test');
const { readShippedHostSource } = require('./helpers/extension-source');

const extension = readShippedHostSource();

test('Add Project and Agent connections reveal the Runlist sidebar when it is not open yet', () => {
  const revealStart = extension.indexOf('async revealRunlistView()');
  const addStart = extension.indexOf('async showAddProject(returnFocus)');
  const agentsStart = extension.indexOf('async showAgentSetup()');
  const addEnd = extension.indexOf('async showProjectTransfer()');

  assert.ok(revealStart !== -1);
  assert.ok(addStart > revealStart);
  assert.ok(agentsStart > addStart);
  assert.ok(addEnd > agentsStart);

  const reveal = extension.slice(revealStart, addStart);
  const addAndAgents = extension.slice(addStart, addEnd);

  assert.match(reveal, /workbench\.view\.extension\.runlist/);
  assert.match(reveal, /runlist\.projects\.focus/);
  assert.match(addAndAgents, /await this\.revealRunlistView\(\)/);
  assert.equal((addAndAgents.match(/await this\.revealRunlistView\(\)/g) || []).length, 2);
  assert.doesNotMatch(addAndAgents, /this\.view\?\.show\?\.\(true\)/);
});

test('Add Project prefills the open workspace folder and focuses the remaining required field', () => {
  const addStart = extension.indexOf('async showAddProject(returnFocus)');
  const addEnd = extension.indexOf('async showAgentSetup()');
  const addProject = extension.slice(addStart, addEnd);

  assert.match(addProject, /starterDraftForCurrentWorkspace\(vscode\.workspace\.workspaceFolders\)/);
  assert.match(addProject, /id: 'start-command'/);
  assert.match(addProject, /id: 'project-name'/);
});

test('sidebar state marks and sorts the This-window project', () => {
  assert.match(extension, /currentWorkspace: workspaceFolderMatchesProject\(/);
  assert.match(extension, /orderSidebarProjects\(projects\.map/);
  assert.match(extension, /currentWorkspaceFolder: currentWorkspaceFolderPath\(/);
});

test('Start This Folder reuses startProject after the This-window decision', () => {
  const start = extension.indexOf('async startThisFolder()');
  const end = extension.indexOf('async showProjectTransfer()');
  const method = extension.slice(start, end);

  assert.match(method, /startThisFolderDecision\(/);
  assert.match(method, /showWarningMessage\(decision\.message\)/);
  assert.match(method, /return this\.startProject\(decision\.projectId\)/);
  assert.doesNotMatch(method, /startProjectProcess/);
  assert.match(extension, /registerCommand\('runlist\.startThisFolder'/);
});
