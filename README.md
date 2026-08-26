# Runlist

Start, stop, and switch local apps from one sidebar.

<img src="media/gallery-01-hero.png" width="1280" alt="Every local app in one VS Code sidebar">

- Every local app, one sidebar
- Save the start command once
- See what’s running, stop or restart from the row
- Open the app from its port, or switch when a port is already in use

## Get started
1. Open the Runlist sidebar
2. Add this folder
3. Save the start command — or pick a `start` / `dev` chip when your folder already has one
4. Start it from the list

<img src="media/gallery-02-status.png" width="1280" alt="See what’s running, elapsed time, and open from the port">

See what’s running. Stop, restart, or open it from here.

<img src="media/gallery-03-features.png" width="1280" alt="First-run: no projects yet, add this folder">

First-run stays empty until you add a folder. No setup dump.

## Features
- Start, stop, and restart from the running row
- Port chip opens the app at localhost when it’s ready
- Checks configured ports before a start, and helps you switch when another Runlist app owns the port
- On a running or conflicted row, shows who owns the port: this app, another Runlist app, or an external process (name and PID)
- What’s Listening lists configured project ports and their listeners; closing a listener always asks for confirmation with the exact port and PID, then checks identity again before stopping anything
- Launch profiles, tags, and run groups for the apps you keep coming back to
- Live preview, recent output, and open-on-phone handoff for local web apps
- Import or export project setups, then review changes before they can run
- Windows, macOS, and Linux

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hankoswart.runlist).

Publisher Hanko Swart. `hankoswart.runlist`.
