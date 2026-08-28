const LISTED_PROJECT_NAMES = 8;

function stopAllConfirmationDetail(projects, count) {
  const names = (projects || [])
    .map((project) => String(project?.name || '').trim())
    .filter(Boolean);
  const listed = names.slice(0, LISTED_PROJECT_NAMES);
  const extra = names.length - listed.length;
  const nameLine = listed.length
    ? `\n\n${listed.join(', ')}${extra > 0 ? `, and ${extra} more` : ''}`
    : '';
  return `This stops ${count} projects Runlist controls from this window. `
    + 'Projects running elsewhere or without a stop command are not affected. '
    + `External listeners are not closed.${nameLine}`;
}

async function confirmStopAllProjects({
  projects = [],
  count,
  showWarningMessage
} = {}) {
  const n = Number.isInteger(count) && count > 0 ? count : projects.length;
  if (typeof showWarningMessage !== 'function') {
    return false;
  }
  const choice = await showWarningMessage(
    'Stop all running projects?',
    {
      modal: true,
      detail: stopAllConfirmationDetail(projects, n)
    },
    'Stop all'
  );
  return choice === 'Stop all';
}

module.exports = {
  confirmStopAllProjects,
  stopAllConfirmationDetail
};
