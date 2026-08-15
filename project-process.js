function terminateTrackedProcess(processes, id) {
  const child = processes.get(id);
  if (!child) {
    return false;
  }

  child.kill('SIGTERM');
  processes.delete(id);
  return true;
}

function cleanupTrackedProcessForDeletion(processes, id, project, stopProject) {
  if (!processes.has(id)) {
    return false;
  }
  if (!project || project.reviewRequired) {
    return terminateTrackedProcess(processes, id);
  }

  stopProject(project);
  return true;
}

module.exports = {
  cleanupTrackedProcessForDeletion,
  terminateTrackedProcess
};
