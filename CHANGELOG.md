# Changelog

## 0.0.11 — Everyday running row and clearer listing

- Show Stop and Restart on the running row, and open the app from the port chip.
- Show elapsed run time on line 2 with status and port.
- Sort unpinned apps by last-started while keeping pinned apps first.
- Offer `start` / `dev` chips on the empty Add this folder state when the current folder’s package.json defines them.
- Rewrite the Marketplace README so Features match shipped behavior: running-row controls, profiles, tags, run groups, preview, phone handoff, and import/export.

## 0.0.10 — Marketplace gallery packaging

- Declare the three signed listing stills as Addressable `Microsoft.VisualStudio.Services.Screenshots.{1,2,3}` VSIX assets so the Marketplace gallery can show them.
- Keep git README image sources as relative `media/` paths, and rewrite the packaged Details README to Marketplace gallery screenshot asset URLs.

## 0.0.9 — Native sidebar and Marketplace listing

- Keep everyday sidebar rows to two lines with native VS Code list chrome and the workbench font.
- Fix first-run Add Project, Start This Folder, and first-add launch profiles.
- Refresh This window when workspace folders change.
- Activate Start and Stop on Remote WSL from the workspace host.

## 0.0.8 — Flexible project runs

- Add alternate launch profiles with their own commands, optional custom stop commands, and services, selectable from the existing Start controls.
- Organize projects with tags, search by tag, and filter the sidebar from one compact disclosure.
- Configure each service for default readiness, port-only checks, or bounded HTTP health checks with method, path, status, timeout, and retry options.
- Run saved groups sequentially or in parallel while preserving ownership-safe rollback and Stop behavior.
- Review bounded coding-agent repair proposals against the exact failed project revision before applying any setup changes.
- Keep healthy services usable when only one port in a multi-port project is blocked, including launch-only temporary port recovery from the affected service row.
- Harden project storage, process ownership, port reservations, and stop requests against stale writes, PID reuse, extension crashes, and multiple VS Code windows.
- Improve narrow-sidebar keyboard focus, lifecycle announcements, service controls, and malformed-message handling without adding permanent card rows.

## 0.0.7 — Safer project control

- Save ordered run groups that wait for each project to become ready and roll back only the projects that group run started when one fails.
- Export one or all project setups, then preview and approve imported additions or changes before their commands can run.
- Resolve one blocked service in a multi-port project with a launch-only port variable and temporary port, without changing the saved setup.
- Review exact process names, ports, and PIDs before closing configured-port listeners, with process identity checked again immediately before termination.
- Recover and coordinate exact Runlist-owned process trees more reliably across VS Code windows, reloads, and local Windows, macOS, and Linux lifecycle transitions.
- Confirm the exact optional custom stop command, enforce its timeout, and verify the project stopped without silently falling back to another stop action.
- Keep local process and port controls safely unavailable in Remote SSH, WSL, Dev Containers, Codespaces, VS Code Tunnels, and Windows WSL network paths.
- Review complete coding-agent repair proposals before saving them, with retrying the project kept as a separate action.

## 0.0.6 — Live apps

- Keep expanded project details stable with separate Overview, Output, Preview, and History tabs.
- Move between off-screen running projects with a compact navigator that stays hidden when the visible list is short.
- See a live runtime pulse with CPU, memory, and recent HTTP response-time samples while project details are open.
- Preview the first responding web app without leaving the sidebar, then refresh it, copy its URL, or open it in the browser.
- Open an eligible local web app on a phone using a private-network URL and QR code generated entirely on the computer.
- Review the five most recent completed starts in a compact history grid, including average ready time and inspectable failure summaries.
- Keep configured local addresses visible in the project row and automatically scroll details that do not fit the sidebar.

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
