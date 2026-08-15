<div align="center">
  <img src="media/switchboard.png" width="80" height="80" alt="Switchboard logo">
  <h1>Switchboard</h1>
  <p><strong>Start and stop your local development projects from one simple VS Code sidebar.</strong></p>
  <p>No more hunting through old notes or trying to remember how each project starts.</p>
  <p>
    <a href="https://github.com/HSwart/Switchboard/releases/download/v0.0.1/switchboard-0.0.1.vsix">
      <img src="https://img.shields.io/badge/Download-Switchboard%200.0.1-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Download Switchboard 0.0.1">
    </a>
  </p>
</div>

---

## Everything you are working on, in one place

Switchboard keeps a reusable list of your local projects inside VS Code. Save each project’s folder and commands once, then use **Start** and **Stop** whenever you return to it.

- Start and stop projects with their saved commands.
- Search saved projects by name or folder.
- Keep configured service names and ports visible at a glance.
- When service ports are configured, see project status and open the first local service in your browser.
- Open any saved project folder in a new VS Code window.
- Edit or remove a saved project without touching its files.

> Switchboard remembers the setup. You stay in control of when a project runs.

## Download and install

Switchboard is tested on Windows, macOS, and Linux.

### 1. Download Switchboard

Download version 0.0.1 here:

**[Download Switchboard 0.0.1](https://github.com/HSwart/Switchboard/releases/download/v0.0.1/switchboard-0.0.1.vsix)**

### 2. Install it in VS Code

1. Open the **Extensions** view in VS Code.
2. Select the **…** menu at the top of the Extensions view.
3. Choose **Install from VSIX…**.
4. Select the `switchboard-0.0.1.vsix` file you downloaded.
5. Reload VS Code when prompted.

After installation, select the Switchboard icon in the VS Code Activity Bar.

## Add your first project

1. Select the **+** button in the Switchboard sidebar.
2. Choose the project folder.
3. Enter the command that starts the project.
4. Enter the command that stops the project.
5. If you know it, enter the app's port so Switchboard can verify its status and open it in your browser.
6. Save it.

Your project is now ready whenever you need it. Select **Start** to run its saved start command and **Stop** to run its saved stop command.

When two saved projects use the same app port, Switchboard identifies the conflict so you can stop the running project first.

If you do not know the exact commands, use the coding-agent setup below. A supported agent can inspect the project and identify its commands and service ports for you.

## Set up a project with your coding agent

Switchboard can also let a supported coding agent save a project for you.

1. Select the **plug** button beside the **+** button to open **Agent connections**.
2. Register Switchboard with Codex or Claude Code. GitHub Copilot is discovered automatically through VS Code.
3. Restart Codex or Claude Code after registration.

Then ask the agent to inspect the project and set it up. For example:

> Inspect this project and add it to Switchboard. Identify the exact start and stop commands, and include the port for every service it runs.

The agent can save or update the project setup. Starting and stopping projects remains a deliberate action in the Switchboard sidebar.

## Day-to-day use

Switchboard keeps the everyday controls simple:

| Control | What it does |
| --- | --- |
| **Search** | Filters your saved projects by project name or folder. |
| **Start** | Runs the saved start command inside the project folder. |
| **Stop** | Runs the saved stop command inside the project folder. |
| **…** | Opens the local app or project folder, edits the setup, or removes the project from Switchboard. |

Removing a project from Switchboard does **not** delete the project or any of its files.

## Your projects stay local

Switchboard stores its project list in your local VS Code data. Switchboard itself does not upload project folders, commands, or service ports. Any coding agent you connect has its own data and privacy settings.

Switchboard is available under the [MIT License](LICENSE).

---

<div align="center">
  <p><strong>Spend less time remembering commands. Spend more time building.</strong></p>
  <p><a href="https://github.com/HSwart/Switchboard/releases/download/v0.0.1/switchboard-0.0.1.vsix">Download Switchboard 0.0.1</a></p>
</div>
