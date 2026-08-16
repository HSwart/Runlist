const fs = require('fs');
const path = require('path');

const MANAGED_MARKER = '<!-- Managed by the Runlist VS Code extension. -->';

const AGENTS = {
  claude: { invocation: '/runlist', root: '.claude' },
  codex: { invocation: '$runlist', root: '.codex' },
  copilot: { invocation: '/runlist', root: '.copilot' }
};

function agentSkillPath(agent, environment = process.env, platform = process.platform) {
  const config = AGENTS[agent];
  if (!config) {
    throw new Error(`Unsupported agent: ${agent}.`);
  }

  const pathForPlatform = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32'
    ? environment.USERPROFILE || environment.HOME
    : environment.HOME || environment.USERPROFILE;
  if (!home) {
    throw new Error('Could not find the user home folder.');
  }

  const agentRoot = agent === 'codex' && environment.CODEX_HOME
    ? environment.CODEX_HOME
    : pathForPlatform.join(home, config.root);
  return pathForPlatform.join(agentRoot, 'skills', 'runlist');
}

function agentSkillStatus(options) {
  const targetDirectory = agentSkillPath(
    options.agent,
    options.environment,
    options.platform
  );
  const skillFile = path.join(targetDirectory, 'SKILL.md');
  if (!fs.existsSync(targetDirectory)) {
    return { invocation: AGENTS[options.agent].invocation, status: 'missing', targetDirectory };
  }

  const target = fs.lstatSync(targetDirectory);
  if (target.isSymbolicLink() || !target.isDirectory()) {
    return { invocation: AGENTS[options.agent].invocation, status: 'conflict', targetDirectory };
  }

  const contents = readText(skillFile);
  return {
    invocation: AGENTS[options.agent].invocation,
    status: contents?.includes(MANAGED_MARKER) ? 'installed' : 'conflict',
    targetDirectory
  };
}

function installAgentSkill(options) {
  const sourceDirectory = options.sourceDirectory;
  const sourceFile = path.join(sourceDirectory, 'SKILL.md');
  const sourceContents = readText(sourceFile);
  if (!sourceContents?.includes(MANAGED_MARKER)) {
    throw new Error('The bundled Runlist skill is invalid.');
  }

  const current = agentSkillStatus(options);
  if (current.status === 'conflict') {
    const error = new Error(
      `A different Runlist skill already exists at ${current.targetDirectory}. Rename or remove it, then try again.`
    );
    error.code = 'ESKILLCONFLICT';
    throw error;
  }

  fs.mkdirSync(path.dirname(current.targetDirectory), { recursive: true });
  fs.cpSync(sourceDirectory, current.targetDirectory, {
    force: true,
    recursive: true
  });

  return {
    invocation: current.invocation,
    targetDirectory: current.targetDirectory
  };
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

module.exports = {
  MANAGED_MARKER,
  agentSkillPath,
  agentSkillStatus,
  installAgentSkill
};
