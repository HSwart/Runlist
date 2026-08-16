# Changelog

## Unreleased

- Refresh detected-running and port-conflict status consistently across VS Code windows.
- Add the current VS Code workspace directly from the project form.
- Configure multiple named services and optional HTTP or HTTPS URLs for each project.
- Keep projects in **Starting…** until every configured service is ready, with a clear **Service not ready** state after 30 seconds.
- Stop the exact process trees Switchboard launched by default.
- Keep the optional custom stop command for projects with a special shutdown workflow.
- Restart a running project safely from its More actions menu.
- Prevent unsafe Stop, Restart, deletion, and service-edit actions when Switchboard cannot guarantee process ownership.
- Prepare Marketplace metadata, package contents, installation guidance, and guarded release validation without publishing.

## 0.0.1 — First public release

### Keep local projects together

- Save each project's folder, friendly name, start command, optional custom stop command, and local services.
- Search projects by name or folder.
- Edit or remove a saved project without changing its files.
- Open a project in a new VS Code window or open its first configured local service in the browser.

### Start, stop, and understand what is running

- Start and stop projects directly from the Switchboard sidebar.
- Stop all running projects when two or more are active.
- See clear states for running, stopped, starting, stopping, detected-running, and port-conflict conditions.
- Keep project status synchronized across multiple open VS Code windows.
- Automatically scroll long project names, status details, and folder paths when they do not fit the sidebar.

### Avoid port clashes safely

- Allow projects to share a saved port when they run at different times.
- Check every configured service port immediately before starting a project.
- Block unsafe starts and identify the Switchboard project using a port when possible.
- Never change a project's ports or stop an unknown process automatically.

### Read recent output

- View output from the latest run inside the sidebar.
- Highlight common log levels and make local web links easy to open.
- Copy the complete recent output and jump back to the latest lines after scrolling up.

### Set up projects with a coding agent

- Connect GitHub Copilot, Codex, or Claude Code from the Agent connections screen.
- Install the guided Switchboard skill for the selected agent with no additional dependencies.
- Let the agent inspect exact project commands and service ports, then save or update the project through Switchboard.
- Review and approve the exact folder, start command, stop command, and services inside Switchboard before agent-created commands can run.
- Preserve any user-created skill that already uses the Switchboard name.

### Platform and privacy

- Tested on Windows, macOS, and Linux.
- Store the Switchboard project list in local VS Code data.
- Publish a clear security policy and private vulnerability-reporting guidance.
- Harden recent-output parsing against crafted log text that could otherwise slow the extension host.
