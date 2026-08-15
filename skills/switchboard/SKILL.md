---
name: switchboard
description: Set up or update a local development project in Switchboard by inspecting its exact start and stop workflow and every explicit service port, then calling switchboard_setup_project. Use when the user asks to add, configure, save, or register a repository or local app in Switchboard, including direct $switchboard or /switchboard requests.
---

<!-- Managed by the Switchboard VS Code extension. -->

# Set up a Switchboard project

1. Resolve the project folder to an absolute path. Use the current repository unless the user names another folder.
2. Inspect the project files to determine the exact command that starts the local app and the exact command that stops everything started by it. Prefer documented project scripts over newly invented commands.
3. Identify every long-running service the start command launches and its explicit TCP port. Trace scripts, configuration, and environment examples as needed. Never guess a port, change a port, or omit a service to make setup easier.
4. Use the user's preferred project name when provided. Otherwise, use the project's existing human-readable name or let Switchboard derive it from the folder.
5. If any command, service, or port remains ambiguous, ask one concise question before saving. Do not ask for confirmation when the configuration is already clear.
6. Call the `switchboard_setup_project` MCP tool with the absolute folder, exact start command, exact stop command, complete service list, and optional friendly name.
7. Report the saved project name, commands, and service ports succinctly.

If the Switchboard MCP tool is unavailable, tell the user to open **Switchboard → Agent connections** in VS Code and select **Set up** for this agent. Do not edit Switchboard's storage file directly.
