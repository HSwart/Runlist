<div align="center">
  <img src="media/runlist.png" width="80" height="80" alt="Runlist logo">
  <h1>Runlist</h1>
  <p><strong>Every local app, across every repository, in one focused VS Code control panel.</strong></p>
  <p>Save each project's folder and commands once, then start, stop, inspect, and open it from the sidebar.</p>
  <p>Set projects up yourself—or optionally let a supported coding agent propose the setup for your approval. Runlist checks configured ports before start and never stops an unknown process to free one.</p>
</div>

---

<p align="center">
  <img src="media/runlist-preview.png" width="900" alt="Stylized preview of Runlist managing three local projects inside VS Code">
</p>

## A control panel for local projects

Runlist keeps a reusable list of local projects from different repositories inside VS Code. It combines saved commands with project status, cautious port checks, quick links, and recent output, so it is more than a list of tasks to run.

- Start projects with their saved commands and safely stop the process trees Runlist launched.
- Search saved projects by name or folder.
- Pin important projects so they stay at the top of the list.
- Give projects a friendly name without renaming their folders.
- Keep configured service names and ports visible at a glance.
- When service ports are configured, see project status, copy a responding web service's URL, and open the first service at its localhost address or optional HTTP/HTTPS URL. Services with an Open URL are also checked for an HTTP response.
- Expand a running web app to see a compact live preview with refresh, copy, and browser actions.
- See current CPU and memory use for the process tree Runlist started while its app preview is expanded.
- Open any saved project folder in a new VS Code window.
- View readable recent output from the latest run, follow new lines, and open web links without leaving the sidebar.
- Edit or remove a saved project without touching its files.

> Runlist remembers the setup. You decide what runs.

## Install

Runlist is tested on Windows, macOS, and Linux.

### Install from the VS Code Marketplace

[Install Runlist from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hankoswart.runlist), or install it from VS Code:

1. Open the **Extensions** view in VS Code.
2. Search for **Runlist**.
3. Confirm that the publisher is **Hanko Swart** and the extension ID is `hankoswart.runlist`.
4. Select **Install**.

After installation, select the Runlist icon in the VS Code Activity Bar.

## Add your first project

1. Select the **+** button in the Runlist sidebar.
2. Optionally enter a friendly project name. If you leave it blank, Runlist uses the folder name.
3. If a local folder is already open in VS Code, choose **Use current workspace**, or select **Browse**. In a multi-root workspace, Runlist asks which local workspace folder to use.
4. Enter the command that starts the project.
5. If the project needs a special shutdown workflow, optionally enter a custom stop command. Most projects should leave this blank.
6. If you know them, add each service name and port so Runlist can verify its status. You can optionally add an HTTP or HTTPS URL to open instead of the service's localhost address. Adding this Open URL also lets Runlist check whether the web service is responding.
7. Save it.

Runlist points out missing or invalid details beside the field that needs attention. If you close the screen after making changes, it asks before discarding them.

Your project is now ready whenever you need it. Select the **Start** icon to run its saved start command. Projects with configured services stay **Starting…** until every saved TCP port is accepting connections. A service with an Open URL also waits for its web page to respond; redirects, sign-in responses, and error pages still count as a response. If its port opens but the page does not respond within 30 seconds, Runlist shows **Web service not responding** while leaving the process running. Services without an Open URL keep using port-based checks. Projects without configured services use the launched process state. Select **Stop** to stop only the process tree Runlist launched. When an explicit custom stop command is configured, Runlist runs it instead.

If Runlist is open in more than one VS Code window, starting or stopping a project in one window updates its status in the others automatically.

Configured service ports are lightweight details, not a port-management system. Projects may save the same service ports because they can still run at different times. Runlist points this out while you add or edit a project, checks every configured port again before starting, and blocks the start if another app is already using one.

If another Runlist project owns a port, Runlist names it. If a shared port is occupied but its owner cannot be identified safely, both Start and Stop remain unavailable until that port is free. Runlist never changes ports or stops an unknown process automatically.

You can set up every project yourself. If you prefer, the optional coding-agent setup below can inspect a project and propose its commands, service ports, and explicitly documented browser URLs for your approval.

## Optional: set up a project with your coding agent

Runlist can also give a supported coding agent a guided setup skill. The agent inspects the project, finds its existing commands, service ports, and explicit browser URLs, and saves the result through Runlist.

1. Select the **plug** button beside the **+** button to open **Agent connections**.
2. Select **Set up** beside the agent you use.
3. Restart Codex after setup. If an already-open Claude Code session does not find the new skill, restart it too.

Then open the project with your agent and use its Runlist skill:

| Agent | What to use |
| --- | --- |
| **GitHub Copilot** | `/runlist` in Copilot CLI, or ask Copilot agent mode to set up the project in Runlist. |
| **Codex** | `$runlist` |
| **Claude Code** | `/runlist` |

You can also describe what you want naturally. For example:

> Inspect this project and add it to Runlist with the name My App. Identify the exact start command and the port for every service it runs. Preserve any explicit HTTP or HTTPS browser URLs, and include a custom stop command only if the project daemonizes or manages external services such as Docker or databases.

The agent can propose a new project or an update to one already in Runlist. The project then shows **Review setup** in the sidebar. Check its folder and exact commands, then select **Approve setup** before Start or Stop becomes available. Agent-proposed commands never run without this approval.

After updating Runlist, return to **Agent connections** and select **Refresh setup** so the agent uses the current connection and skill. Runlist will not replace a different skill you created with the same name.

## Day-to-day use

Runlist keeps the everyday controls simple:

| Control | What it does |
| --- | --- |
| **Search** | Filters your saved projects by project name or folder. |
| **Pin to top** | In a project's More actions menu, keeps that project above unpinned projects until you unpin it. |
| **Project status** | Shows the written state in a clear status capsule, including running, stopped, transitions, a web service that is not responding, and port conflicts. Long names, status details, and folder paths scroll automatically when they do not fit. |
| **Start icon** | Runs the saved start command inside the project folder. |
| **Stop icon** | Stops the process tree Runlist launched, or runs the optional custom stop command when one is configured. |
| **Restart** | In a project's More actions menu, safely stops that project before starting it again and checking service readiness. |
| **Stop all running** | Appears when two or more projects are running and stops them together. |
| **Port in use** | Prevents conflicting projects from starting and identifies the owning project when possible. |
| **Copy URL** | Appears beside the responding first service, and beside other responding services with an Open URL. It copies the same safe URL Runlist would open. |
| **Preview app** | A chevron appears at the far right of the responding first web service row. Expand it to load one live preview beneath the project; collapsing or stopping the app unloads it. Some apps block embedded views, so Open in browser remains available. |
| **Resource use** | Shows current CPU and memory inside an expanded preview when this VS Code window started the project. Runlist stops measuring when the preview closes or ownership is uncertain. |
| **View output** | Highlights common log levels, opens web links, and lets you copy output from the latest run. If you scroll up, Runlist keeps your place and offers a **Latest** button when new output arrives. |
| **…** | Opens the app, project folder, recent output, edit screen, or remove action. |

Removing a project from Runlist does **not** delete the project or any of its files.

If Runlist finds a configured service already running but did not start it itself, the project is labelled **Detected running** so its state is clear.

## Your projects stay local

Runlist stores its project list in your local VS Code data. Runlist itself does not upload project folders, commands, service ports, or URL overrides. Any coding agent you connect has its own data and privacy settings.

## Security

Found a possible security issue? Please read the [security policy](SECURITY.md) and report it privately. Do not share sensitive details in a public issue.

Runlist is available under the [MIT License](LICENSE).

---

<div align="center">
  <p><strong>Spend less time remembering commands. Spend more time building.</strong></p>
</div>
