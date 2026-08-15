function terminateTrackedProcess(processes, id) {
  const child = processes.get(id);
  if (!child) {
    return false;
  }

  child.kill('SIGTERM');
  processes.delete(id);
  return true;
}

module.exports = { terminateTrackedProcess };
