---
name: runlist
description: Set up or update a local development project in Runlist, or diagnose a retained failed start when the user provides a Runlist project ID. Use for Runlist setup requests and copied Runlist diagnosis requests.
---

<!-- Managed by the Runlist VS Code extension. -->

# Set up a Runlist project

1. Resolve the project folder to an absolute path. Use the current repository unless the user names another folder.
2. Inspect the project files to determine the exact command that starts the local app. Runlist stops the process tree it launches by default. Include a custom stop command only when the project needs an advanced shutdown workflow, such as a detached service, container, or database. Prefer documented project scripts and never invent a broad process-matching command.
3. Identify every long-running service the start command launches and its explicit TCP port. Trace scripts, configuration, and environment examples as needed. Never guess a port, change a port, or omit a service to make setup easier.
4. When the project explicitly documents an HTTP or HTTPS browser URL for a service, include it as that service's optional `url`. Preserve custom hostnames, HTTPS, and paths. Omit `url` when none is explicit; never derive or guess one from the port.
5. Use the user's preferred project name when provided. Otherwise, use the project's existing human-readable name or let Runlist derive it from the folder.
6. If the start command, service, port, or need for a custom stop workflow remains ambiguous, ask one concise question before saving. Do not ask for confirmation when the configuration is already clear.
7. Call the `runlist_setup_project` MCP tool with the absolute folder, exact start command, complete service list with any explicit URL overrides, optional custom stop command, and optional friendly name.
8. Report the saved project name, start command, any custom stop command, service ports, and included URL overrides succinctly. Tell the user to review and approve the setup in the Runlist sidebar before running it.

When the repository already has a committed Runlist stack file (`runlist.json` or `.runlist/projects.json`), tell the user they can use **Runlist → Import or Export → Load stack from this workspace**, review the exact folders and commands, and approve before anything can run. Do not put secrets, env files, or tokens in that stack file.

If the Runlist MCP tool is unavailable, tell the user to open **Runlist → Agent connections** in VS Code and select **Set up** for this agent. Do not edit Runlist's storage file directly.

# Diagnose a failed Runlist start

When the user pastes a Runlist diagnosis request containing a project ID:

1. Call `runlist_get_project_diagnostics` with that exact project ID. Do not substitute a name or folder and do not request diagnostics for other projects.
2. Diagnose only the returned saved setup, platform, lifecycle result, failure summary, and sanitized retained output. Explain the likely cause and the smallest safe next step.
3. Do not run commands, install dependencies, edit files, rerun the project, or change its saved Runlist setup.
4. If the saved name, folder, start command, stop command, or services should change, call `runlist_propose_project_repair` with the exact `projectId`, `projectRevision`, and `failedAt` values returned by the diagnostics. Include only the setup fields that should change.
5. Tell the user to select **Refresh proposal** in Runlist, inspect the complete current-versus-proposed comparison, and approve or reject it there. Runlist never applies or retries the proposal automatically.

If no retained failure is available, tell the user to start the project from Runlist again and use **View output → Ask your agent** after the failure.
