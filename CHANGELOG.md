# Changelog

## 0.0.5 — Live project cards

- Follow a project's startup progress directly inside its expanded sidebar card.
- See the latest three useful output lines while a project starts or runs, then open Recent Output for the complete retained log.
- Switch safely between two Runlist-managed projects that need the same port by stopping the verified owner before starting the selected project.
- Keep unknown, external, ambiguous, or ownership-uncertain port conflicts blocked without stopping another process.
- Prepare a bounded, sanitized failed-start diagnosis request for Copilot, Codex, or Claude without sending anything automatically.
- Keep any setup change proposed by a coding agent behind Runlist's existing review-and-approval step.

## 0.0.4 — Clearer starts and quicker access

- Show a concise, useful failure summary when a project cannot start while keeping its complete recent output available.
- Keep slow projects in a clear **Taking longer…** state while Runlist continues checking every configured service.
- Preview the first configured web service that responds, even while another service is still starting.
- Open a VS Code terminal directly in a project's saved folder.
- Copy a project's exact saved folder path from its More actions menu.
- Publish Runlist as a stable Marketplace extension rather than a Preview extension.

## 0.0.3 — Project visibility

- Pin important projects so they stay above unpinned projects.
- Check configured web services for an HTTP response and clearly distinguish a service that is reachable but not responding.
- Copy a responding local service URL directly from its service badge.
- Expand a running web service from the chevron at the right of its service row to see a compact live app preview.
- Refresh the preview, copy its URL, or open it in the browser without leaving the sidebar.
- Show current CPU and memory use for the process tree Runlist started while its preview is expanded.
- Use VS Code-style disclosure and restart icons, with warning styling for nonresponding web services.

## 0.0.2 — Marketplace release

- Rebrand the extension, Marketplace identity, agent connection, and guided setup skill as Runlist.
- Refresh detected-running and port-conflict status consistently across VS Code windows.
- Add the current VS Code workspace directly from the project form.
- Configure multiple named services and optional HTTP or HTTPS URLs for each project.
- Keep projects in **Starting…** until every configured service is ready, with a clear **Service not ready** state after 30 seconds.
- Stop the exact process trees Runlist launched by default.
- Keep the optional custom stop command for projects with a special shutdown workflow.
- Restart a running project safely from its More actions menu.
- Prevent unsafe Stop, Restart, deletion, and service-edit actions when Runlist cannot guarantee process ownership.
- Prepare Marketplace metadata, package contents, installation guidance, and guarded release validation without publishing.

## 0.0.1 — First public release

### Keep local projects together

- Save each project's folder, friendly name, start command, optional custom stop command, and local services.
- Search projects by name or folder.
- Edit or remove a saved project without changing its files.
- Open a project in a new VS Code window or open its first configured local service in the browser.

### Start, stop, and understand what is running

- Start and stop projects directly from the Runlist sidebar.
- Stop all running projects when two or more are active.
- See clear states for running, stopped, starting, stopping, detected-running, and port-conflict conditions.
- Keep project status synchronized across multiple open VS Code windows.
- Automatically scroll long project names, status details, and folder paths when they do not fit the sidebar.

### Avoid port clashes safely

- Allow projects to share a saved port when they run at different times.
- Check every configured service port immediately before starting a project.
- Block unsafe starts and identify the Runlist project using a port when possible.
- Never change a project's ports or stop an unknown process automatically.

### Read recent output

- View output from the latest run inside the sidebar.
- Highlight common log levels and make local web links easy to open.
- Copy the complete recent output and jump back to the latest lines after scrolling up.

### Set up projects with a coding agent

- Connect GitHub Copilot, Codex, or Claude Code from the Agent connections screen.
- Install the guided Runlist skill for the selected agent with no additional dependencies.
- Let the agent inspect exact project commands and service ports, then save or update the project through Runlist.
- Review and approve the exact folder, start command, stop command, and services inside Runlist before agent-created commands can run.
- Preserve any user-created skill that already uses the Runlist name.

### Platform and privacy

- Tested on Windows, macOS, and Linux.
- Store the Runlist project list in local VS Code data.
- Publish a clear security policy and private vulnerability-reporting guidance.
- Harden recent-output parsing against crafted log text that could otherwise slow the extension host.
