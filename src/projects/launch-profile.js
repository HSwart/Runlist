const DEFAULT_LAUNCH_PROFILE_ID = 'default';
const DEFAULT_LAUNCH_PROFILE_NAME = 'Default';
const MAX_LAUNCH_PROFILES = 12;

function launchProfileOptions(project = {}) {
  return [
    {
      id: DEFAULT_LAUNCH_PROFILE_ID,
      name: DEFAULT_LAUNCH_PROFILE_NAME,
      startCommand: project.startCommand,
      ...(project.stopCommand ? { stopCommand: project.stopCommand } : {}),
      services: Array.isArray(project.services) ? project.services : []
    },
    ...(Array.isArray(project.launchProfiles) ? project.launchProfiles : [])
  ];
}

function selectedLaunchProfileId(project = {}) {
  const requested = project.selectedLaunchProfileId;
  return launchProfileOptions(project).some((profile) => profile.id === requested)
    ? requested
    : DEFAULT_LAUNCH_PROFILE_ID;
}

function selectedLaunchProfile(project = {}) {
  const id = selectedLaunchProfileId(project);
  return launchProfileOptions(project).find((profile) => profile.id === id);
}

function resolveLaunchProfile(project = {}, profileId) {
  if (!Object.hasOwn(project, 'startCommand')
    && !Array.isArray(project.launchProfiles)
    && project.selectedLaunchProfileId === undefined) {
    return project;
  }
  const options = launchProfileOptions(project);
  const requested = profileId || selectedLaunchProfileId(project);
  const profile = options.find((candidate) => candidate.id === requested) || options[0];
  const resolved = {
    ...project,
    startCommand: profile.startCommand,
    services: Array.isArray(profile.services) ? profile.services.map((service) => ({ ...service })) : [],
    activeLaunchProfileId: profile.id,
    activeLaunchProfileName: profile.name
  };
  if (profile.stopCommand) {
    resolved.stopCommand = profile.stopCommand;
  } else {
    delete resolved.stopCommand;
  }
  return resolved;
}

module.exports = {
  DEFAULT_LAUNCH_PROFILE_ID,
  DEFAULT_LAUNCH_PROFILE_NAME,
  launchProfileOptions,
  MAX_LAUNCH_PROFILES,
  resolveLaunchProfile,
  selectedLaunchProfile,
  selectedLaunchProfileId
};
