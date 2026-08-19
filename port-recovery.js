async function recoverProjectPorts(project, intent, options) {
  const initialOpenPorts = normalizedPorts(await options.getOpenPorts(project.services || []));
  if (!initialOpenPorts.length) {
    return { status: 'closed', openPorts: [], processCount: 0 };
  }

  const initialListeners = listenersForPorts(
    await options.findListeningProcesses(initialOpenPorts),
    initialOpenPorts
  );
  const unresolved = unresolvedPorts(initialOpenPorts, initialListeners);
  if (unresolved.length) {
    return { status: 'unresolved', ports: unresolved };
  }

  const additionalProcesses = validAdditionalProcesses(options.additionalProcesses);
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
      allowMissing: processInfo.ports.length === 0
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
  lines.push('', 'These processes may belong to another app. Unsaved work in them could be lost.');
  return {
    message: intent === 'start'
      ? `Close the processes blocking ${project.name}?`
      : `Close the processes using ${project.name}'s ports?`,
    confirmLabel: intent === 'start' ? 'Close processes and start' : 'Close processes',
    detail: lines.join('\n')
  };
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
      ports: normalizedPorts(candidate.ports)
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
      existing.ports.sort((left, right) => left - right);
      continue;
    }
    grouped.set(key, {
      pid: listener.pid,
      identity: listener.identity,
      name: String(listener.name || 'Unknown process'),
      ports
    });
  }
  return [...grouped.values()].sort((left, right) => (
    Number(right.ports.length > 0) - Number(left.ports.length > 0)
    || left.pid - right.pid
  ));
}

module.exports = { portClosureConfirmation, recoverProjectPorts };
