async function recoverProjectPorts(project, intent, options) {
  const additionalProcesses = validAdditionalProcesses(options.additionalProcesses);
  const initialOpenPorts = normalizedPorts(await options.getOpenPorts(project.services || []));
  if (!initialOpenPorts.length && (intent !== 'stop' || !additionalProcesses.length)) {
    return { status: 'closed', openPorts: [], processCount: 0 };
  }

  const initialListeners = initialOpenPorts.length
    ? listenersForPorts(
      await options.findListeningProcesses(initialOpenPorts),
      initialOpenPorts
    )
    : [];
  const unresolved = unresolvedPorts(initialOpenPorts, initialListeners);
  if (unresolved.length) {
    return { status: 'unresolved', ports: unresolved };
  }

  const initialProcesses = groupProcesses([...initialListeners, ...additionalProcesses]);
  const protectedPids = options.protectedPids || new Set([process.pid]);
  const protectedProcesses = initialProcesses.filter((candidate) => protectedPids.has(candidate.pid));
  if (protectedProcesses.length) {
    return {
      status: 'protected',
      processes: protectedProcesses.map((candidate) => `${candidate.name} (PID ${candidate.pid})`)
    };
  }

  const confirmed = await options.confirmPortClosure({
    intent,
    openPorts: initialOpenPorts,
    processes: initialProcesses
  });
  if (!confirmed) {
    return { status: 'canceled' };
  }

  const currentOpenPorts = normalizedPorts(await options.getOpenPorts(project.services || []));
  const currentListeners = currentOpenPorts.length
    ? listenersForPorts(
      await options.findListeningProcesses(currentOpenPorts),
      currentOpenPorts
    )
    : [];
  if ((currentOpenPorts.length && unresolvedPorts(currentOpenPorts, currentListeners).length)
    || currentListeners.some((current) => !initialListeners.some((initial) => (
      initial.port === current.port
      && initial.pid === current.pid
      && initial.identity === current.identity
    )))) {
    return { status: 'changed' };
  }

  const processes = groupProcesses([...currentListeners, ...additionalProcesses]);
  for (const processInfo of processes) {
    await options.terminateListenerProcess(processInfo, {
      allowMissing: processInfo.ports.length === 0,
      terminateTree: processInfo.terminateTree
    });
  }
  const closed = await options.waitForPortsClosed(project.services || []);
  return closed
    ? { status: 'closed', openPorts: initialOpenPorts, processCount: processes.length }
    : { status: 'still-open', ports: currentOpenPorts };
}

function portClosureConfirmation(project, intent, openPorts, processes) {
  const services = new Map((project?.services || []).map((service) => [service.port, service.name]));
  const lines = normalizedPorts(openPorts).map((port) => {
    const owners = (processes || []).filter((candidate) => candidate.ports?.includes(port));
    const ownerText = owners.map((candidate) => (
      `${candidate.name} (PID ${candidate.pid})`
    )).join(', ');
    return `${services.get(port) || 'service'} :${port} — ${ownerText || 'Unknown process'}`;
  });
  for (const processInfo of (processes || []).filter((candidate) => !candidate.ports?.length)) {
    lines.push(`Project process — ${processInfo.name} (PID ${processInfo.pid})`);
  }
  lines.push(
    '',
    'Runlist may not have started these processes. Closing them can stop another app and discard unsaved work.',
    '',
    'Are you sure you want to continue?'
  );
  return {
    message: intent === 'start'
      ? `Close the processes blocking ${project.name}?`
      : openPorts.length
        ? `Close the processes using ${project.name}'s ports?`
        : `Close the saved process running ${project.name}?`,
    confirmLabel: intent === 'start' ? 'Yes, close processes and start' : 'Yes, close processes',
    detail: lines.join('\n')
  };
}

function formatRecoveryPorts(ports) {
  const values = normalizedPorts(ports);
  if (!values.length) {
    return 'the configured ports';
  }
  if (values.length === 1) {
    return `:${values[0]}`;
  }
  if (values.length === 2) {
    return `:${values[0]} and :${values[1]}`;
  }
  return `${values.slice(0, -1).map((port) => `:${port}`).join(', ')}, and :${values.at(-1)}`;
}

/**
 * Plain-language outcome copy for diagnosis and run-row close entry points.
 * Returns null when the host should stay silent (canceled / no-op close).
 */
function portCloseUserMessage(projectName, result, intent = 'stop') {
  const name = typeof projectName === 'string' && projectName.trim()
    ? projectName.trim()
    : 'this project';
  switch (result?.status) {
    case 'unresolved':
      return {
        level: 'error',
        text: `Could not close ${name}'s ports: Runlist could not identify the exact process listening on ${formatRecoveryPorts(result.ports)}.`
      };
    case 'protected':
      return {
        level: 'error',
        text: `Could not close ${name}'s ports because ${result.processes.join(', ')} is protected.`
      };
    case 'changed':
      return {
        level: 'warning',
        text: `The process on ${name}'s port changed while you confirmed. Nothing was stopped. Whatever is listening now was left running.`
      };
    case 'still-open':
      return {
        level: 'error',
        text: `Could not close ${name}'s ports: ${formatRecoveryPorts(result.ports)} is still in use.`
      };
    case 'closed':
      if (!result.processCount) {
        return null;
      }
      if (intent === 'start') {
        return {
          level: 'info',
          text: `Closed the process on ${formatRecoveryPorts(result.openPorts)}. Starting ${name}…`
        };
      }
      if (result.openPorts?.length) {
        return {
          level: 'info',
          text: `Closed the process on ${formatRecoveryPorts(result.openPorts)}.`
        };
      }
      return {
        level: 'info',
        text: `Closed the saved process for ${name}.`
      };
    default:
      return null;
  }
}

function normalizedPorts(ports) {
  return [...new Set((ports || [])
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))]
    .sort((left, right) => left - right);
}

function listenersForPorts(listeners, ports) {
  const allowed = new Set(ports);
  return (listeners || []).filter((listener) => allowed.has(listener.port)
    && Number.isInteger(listener.pid)
    && listener.pid > 0);
}

function validAdditionalProcesses(processes) {
  return (processes || []).filter((candidate) => Number.isInteger(candidate?.pid)
    && candidate.pid > 0
    && typeof candidate.identity === 'string')
    .map((candidate) => ({
      pid: candidate.pid,
      identity: candidate.identity,
      name: String(candidate.name || 'Saved Runlist process'),
      ports: normalizedPorts(candidate.ports),
      ...(candidate.terminateTree === true ? { terminateTree: true } : {})
    }));
}

function unresolvedPorts(ports, listeners) {
  return ports.filter((port) => {
    const owners = listeners.filter((listener) => listener.port === port);
    return !owners.length || owners.some((listener) => typeof listener.identity !== 'string');
  });
}

function groupProcesses(listeners) {
  const grouped = new Map();
  for (const listener of listeners) {
    const key = `${listener.pid}:${listener.identity}`;
    const ports = normalizedPorts(listener.ports || [listener.port]);
    const existing = grouped.get(key);
    if (existing) {
      for (const port of ports) {
        if (!existing.ports.includes(port)) {
          existing.ports.push(port);
        }
      }
      if (listener.terminateTree === true) {
        existing.terminateTree = true;
      }
      existing.ports.sort((left, right) => left - right);
      continue;
    }
    grouped.set(key, {
      pid: listener.pid,
      identity: listener.identity,
      name: String(listener.name || 'Unknown process'),
      ports,
      ...(listener.terminateTree === true ? { terminateTree: true } : {})
    });
  }
  return [...grouped.values()].sort((left, right) => (
    Number(left.terminateTree === true) - Number(right.terminateTree === true)
    || Number(right.ports.length > 0) - Number(left.ports.length > 0)
    || left.pid - right.pid
  ));
}

function managedPortBlockers(
  projectIds,
  processRuntime,
  projects = [],
  localDetachedProjectIds = new Set()
) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return [...new Set(projectIds || [])].map((projectId) => {
    const ownership = processRuntime?.get(projectId);
    if (!localDetachedProjectIds.has(projectId)
      && (!ownership?.ownerAvailable || !ownership.processActive)) {
      return undefined;
    }
    return {
      id: projectId,
      name: names.get(projectId) || 'Another Runlist project'
    };
  }).filter(Boolean);
}

function relatedPortProjectIds(project, reservationConflicts = [], projects = []) {
  const targetPorts = new Set(normalizedPorts((project?.services || []).map((service) => service.port)));
  const relatedIds = new Set((reservationConflicts || [])
    .map((conflict) => conflict.projectId)
    .filter((projectId) => typeof projectId === 'string' && projectId !== project?.id));
  for (const candidate of projects) {
    if (candidate.id !== project?.id
      && (candidate.services || []).some((service) => targetPorts.has(Number(service.port)))) {
      relatedIds.add(candidate.id);
    }
  }
  return relatedIds;
}

module.exports = {
  managedPortBlockers,
  portClosureConfirmation,
  portCloseUserMessage,
  recoverProjectPorts,
  relatedPortProjectIds
};
