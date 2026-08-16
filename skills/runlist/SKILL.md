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

If the Runlist MCP tool is unavailable, tell the user to open **Runlist → Agent connections** in VS Code and select **Set up** for this agent. Do not edit Runlist's storage file directly.

# Diagnose a failed Runlist start

When the user pastes a Runlist diagnosis request containing a project ID:

1. Call `runlist_get_project_diagnostics` with that exact project ID. Do not substitute a name or folder and do not request diagnostics for other projects.
2. Diagnose only the returned saved setup, platform, lifecycle result, failure summary, and sanitized retained output. Explain the likely cause and the smallest safe next step.
3. Do not run commands, install dependencies, edit files, rerun the project, or change its Runlist setup unless the user separately asks you to do so.
4. If a Runlist command or service change is appropriate, propose it clearly. Save it only through `runlist_setup_project`; Runlist will keep the update blocked until the user reviews and approves it.

If no retained failure is available, tell the user to start the project from Runlist again and use **View output → Ask your agent** after the failure.
