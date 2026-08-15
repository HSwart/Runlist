---
name: switchboard
description: Set up or update a local development project in Switchboard by inspecting its exact start workflow, any necessary custom stop workflow, every explicit service port, and any explicit browser URLs, then calling switchboard_setup_project. Use when the user asks to add, configure, save, or register a repository or local app in Switchboard, including direct $switchboard or /switchboard requests.
---

<!-- Managed by the Switchboard VS Code extension. -->

# Set up a Switchboard project

1. Resolve the project folder to an absolute path. Use the current repository unless the user names another folder.
2. Inspect the project files to determine the exact command that starts the local app. Switchboard stops the process tree it launches by default. Include a custom stop command only when the project needs an advanced shutdown workflow, such as a detached service, container, or database. Prefer documented project scripts and never invent a broad process-matching command.
3. Identify every long-running service the start command launches and its explicit TCP port. Trace scripts, configuration, and environment examples as needed. Never guess a port, change a port, or omit a service to make setup easier.
4. When the project explicitly documents an HTTP or HTTPS browser URL for a service, include it as that service's optional `url`. Preserve custom hostnames, HTTPS, and paths. Omit `url` when none is explicit; never derive or guess one from the port.
5. Use the user's preferred project name when provided. Otherwise, use the project's existing human-readable name or let Switchboard derive it from the folder.
6. If the start command, service, port, or need for a custom stop workflow remains ambiguous, ask one concise question before saving. Do not ask for confirmation when the configuration is already clear.
7. Call the `switchboard_setup_project` MCP tool with the absolute folder, exact start command, complete service list with any explicit URL overrides, optional custom stop command, and optional friendly name.
8. Report the saved project name, start command, any custom stop command, service ports, and included URL overrides succinctly. Tell the user to review and approve the setup in the Switchboard sidebar before running it.

If the Switchboard MCP tool is unavailable, tell the user to open **Switchboard → Agent connections** in VS Code and select **Set up** for this agent. Do not edit Switchboard's storage file directly.
