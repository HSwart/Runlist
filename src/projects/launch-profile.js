const DEFAULT_LAUNCH_PROFILE_ID = 'default';
const DEFAULT_LAUNCH_PROFILE_NAME = 'Default';
const MAX_LAUNCH_PROFILES = 12;
const MAX_ALTERNATE_LAUNCH_PROFILES = MAX_LAUNCH_PROFILES - 1;

function launchProfileOptions(project = {}) {
  return [
    {
      id: DEFAULT_LAUNCH_PROFILE_ID,
      name: DEFAULT_LAUNCH_PROFILE_NAME,
      startCommand: project.startCommand,
      ...(project.stopCommand ? { stopCommand: project.stopCommand } : {}),
      ...(project.envFile ? { envFile: project.envFile } : {}),
      ...(project.env ? { env: { ...project.env } } : {}),
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
  if (profile.envFile) {
    resolved.envFile = profile.envFile;
  } else {
    delete resolved.envFile;
  }
  if (profile.env) {
    resolved.env = { ...profile.env };
  } else {
    delete resolved.env;
  }
  return resolved;
}

module.exports = {
  DEFAULT_LAUNCH_PROFILE_ID,
  DEFAULT_LAUNCH_PROFILE_NAME,
  launchProfileOptions,
  MAX_ALTERNATE_LAUNCH_PROFILES,
  MAX_LAUNCH_PROFILES,
  resolveLaunchProfile,
  selectedLaunchProfile,
  selectedLaunchProfileId
};
