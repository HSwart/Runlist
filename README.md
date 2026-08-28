# Runlist

**Your local apps. One calm sidebar.**

Start, stop, and switch everything you’re running locally — without hunting terminals, guessing ports, or losing track of what is still up.

<img src="media/gallery-01-hero.png" width="1280" alt="Every local app in one VS Code sidebar">

Runlist is a focused VS Code sidebar for people who run real projects every day: web apps, APIs, workers, Compose stacks, and the odd side project that still needs a start command. Save each app once. Control it from the list. Open it when it’s ready.

- **One place for every local app** — pinned favorites, recent work, and the rest of your list
- **Save the start command once** — then Start, Stop, and Restart from the row
- **See what’s actually running** — status, timing, and a clear fail reason when something breaks
- **Open the app when it’s ready** — from the port chip, with live preview when you want it
- **Handle busy ports without drama** — switch when another Runlist app owns the port, or inspect what’s listening

## Get started

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hankoswart.runlist)
2. Open the **Runlist** sidebar
3. If this window has no folder yet, choose **Open folder**
4. Choose **Add this folder**
5. Save the start command — or pick a `start` / `dev` chip when your folder already has one
6. Press **Start**

That’s it. First-run stays empty until you add a folder. No setup dump, no config maze.

<img src="media/gallery-02-status.png" width="1280" alt="See what’s running, stop it, and open it from here">

See what’s running. Stop it, restart it, or open it from here.

<img src="media/gallery-03-features.png" width="1280" alt="First-run: no projects yet, add this folder">

First-run stays empty until you add a folder.

## Everyday workflow

Once an app is saved, the row is the control surface.

- **Start, Stop, and Restart** stay on the project row — including while it’s running
- **Status stays honest** — starting, ready, not responding, failed, and why
- **Open from the port chip** when the web service is up
- **Live preview and recent output** when you expand the project
- **Search and pin** so the apps you touch all day stay on top
- **Open in VS Code**, open a terminal here, or copy the project path from the More menu

Works on **Windows, macOS, and Linux**.

## Ports, conflicts, and recovery

Local development breaks most often on ports. Runlist treats that as a first-class problem.

- Checks configured ports **before** Start
- Helps you **switch** when another Runlist app already owns the port
- Shows conflict state on the row when something is blocked
- **What’s Listening** lists your configured project ports and who’s on them
- Closing a listener asks for confirmation with the exact port and process — then checks again before anything stops
- If only one service in a multi-port app is blocked, you can resolve that port without rewriting the whole setup

## Open in the browser — or on your phone

- Open the app from the port chip or the More menu
- Optional **local hostname** opens as `name.localhost` when it fits, and falls back to `localhost` when it doesn’t
- **Open on phone** shows a QR code when the app listens on your local network — not when it is loopback-only (`127.0.0.1`)

Named local hostnames are for this machine. Phone handoff is for devices on the same network — not a public tunnel.

## Organize the work you repeat

- **Launch profiles** — keep alternate start commands, stop commands, and services for the same project
- **Tags** — label apps and filter the list down to what you need right now
- **Groups** — start related apps together, in order or in parallel, and stop them as a set
- **More menu (⋯)** — Set Up Agents, Import or Export, Load stack, Manage groups, What’s Listening, and support info

## Bring a whole stack into the sidebar

- **Load stack** — pull a shared project setup from the repo, review what’s new or changing, then load it
- **Import or Export** — move setups between machines or teammates, with review before anything can run
- **Docker Compose import** — review services first; Compose is not started until you press Start
- **Optional env file** on a launch profile — attach a local file so Start has what it needs (keep secrets in the file, not in exports)

Nothing auto-starts on clone. You review, then you start.

## Built for people who live in VS Code

Runlist stays out of the way until you need it, then gives you the controls that usually live across terminals, browser tabs, and sticky notes:

- A clean two-line row for everyday status
- Clear actions when something fails
- Safe coordination when the same projects are open in more than one VS Code window
- Agent setup that still requires review before a new project can start

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hankoswart.runlist).

Publisher Hanko Swart. `hankoswart.runlist`.
