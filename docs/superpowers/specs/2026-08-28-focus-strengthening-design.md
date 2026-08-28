# Runlist focus strengthening — design

**Status:** proposed  
**Date:** 2026-08-28  
**Constraint:** Keep every currently implemented feature. Strengthen first-run clarity, Marketplace focus, and version discipline. Do not remove advanced surfaces from the product.

## Problem

Runlist already solves a real job: start, stop, see status, open local apps from one sidebar. The engineering bar (process safety, ports, multi-window ownership) is ahead of most first public indie tools.

The risk is attention, not capability. Advanced surfaces (profiles, tags, groups, stacks, Compose, agents/MCP, phone QR, live preview) are real and should stay. They currently compete with the core loop in README structure, first-add form length, and Marketplace signal (`0.0.x`, dense hero gallery, keyword breadth).

## Goals

1. Make the stranger loop inevitable: install → open Runlist → add folder → save start command → Start → Ready → Open.
2. Keep all features; demote advanced ones in attention (UI progressive disclosure + Marketplace hierarchy), not in code.
3. Define honest version bars for **0.1.0** (focus release) and **1.0.0** (public promise you stand behind).
4. Preserve existing product rules: no sidebar marketing essays, claim-accurate README, safe process/port behavior unchanged unless a task explicitly improves recovery copy.

## Non-goals

- Deleting or feature-flagging away profiles, tags, groups, stacks, Compose, agents, MCP, phone handoff, or preview.
- Expanding remote/WSL Start support in this package.
- Changing extension identity (`hankoswart.runlist`), adding paid tiers, or rewriting lifecycle/ownership semantics.
- Broad visual redesign or new organization metaphors.

## Packaging decision

Ship as **one focus release** ending in **0.1.0**:

| Track | What changes |
| --- | --- |
| A. First-run / Add form | Progressive disclosure; chip clarity; remote caveat timing |
| B. Marketplace / README | Above-the-fold core story; advanced sections demoted; keywords; **keep existing gallery-01 hero unchanged** |
| C. Discoverability | One optional post-install tip (not sidebar copy) |
| D. Version | Bump to `0.1.0` only after A–C land and `npm run verify` + `npm run package` pass |

Advanced features remain reachable from Edit, project More menu, and global `⋯`.

## Design

### 1. First-run empty state

**Keep**

- Headline: `No projects yet`
- Short folder-oriented copy (no product pitch — existing density tests forbid marketing essays)
- Primary: **Add this folder**
- Optional **Load stack** when a stack contract is pending
- Start / Dev chips when `package.json` exposes those scripts

**Clarify**

Empty-state Start / Dev chips today **save the folder and start** (`startWorkspaceScript`). Add-form chips only **fill** the start command (`useDraftStartScript`). That difference must be obvious without a paragraph:

- Empty-state chip accessible name / title must say they will save and start (e.g. title already has the command; ensure aria-label implies start, not “fill”).
- Prefer visible micro-hint only if tests and narrow-sidebar density allow — otherwise strengthen `title` / `aria-label` only.
- Do **not** change chip behavior in this package unless a follow-up issue explicitly chooses “fill only” on empty state.

**Defer**

- Lifecycle unsupported remote/WSL network-path explanation: keep accurate, but prefer showing it when Start is attempted in an unsupported window, or as a compact secondary line after the primary CTA — not as the first thing a local user reads. Exact placement is an implementation task with regression tests updating `webview-list-density` / empty-state tests carefully.

### 2. Add project form (first add)

**Always visible on first add**

- Folder (prefilled from workspace when possible)
- Start command (with fill-only Start/Dev chips)
- Save project

**Behind “More options” (collapsed `<details>` or equivalent) on first add**

- Project name (still optional; default folder name)
- Local hostname
- Tags
- Custom stop command
- Env file / env overrides
- Services / health editor

**Already correct — preserve**

- Launch profile editor hidden on first add when only Default exists (`hides launch profiles on first add when only Default exists`).

**Edit / review modes**

- Keep today’s fuller form (or expand More options by default when editing a project that already uses advanced fields).
- Do not hide fields the user already filled; reopening Edit must show their data.

### 3. Post-install discoverability

Optional one-time tip via `vscode.window.showInformationMessage` after activation when:

- globalState flag unset (e.g. `runlist.didShowOpenTip`)
- no projects saved yet
- host role activates normally

Message example: `Open Runlist to save and control local apps.`  
Actions: `Open Runlist` | `Dismiss`  
`Open Runlist` reveals the Runlist view (`workbench.view.extension.runlist` / existing reveal helper).

Do **not** add explanatory product copy into the empty-state webview (density test).

### 4. Marketplace positioning

**Keep** short description:

> Start, stop, and switch local apps from one sidebar.

**Keywords**

- Keep the first five focused on core intent (current lead set is good direction).
- Demote or drop agent/MCP terms from the keyword list used for Marketplace search noise; agents remain in-product via More menu.
- Update `test/marketplace-readiness.test.js` in the same change.

**README hierarchy**

1. Hero: calm one-liner + 4–5 core bullets + gallery-01  
2. Get started (install → sidebar → Add this folder → Start)  
3. Everyday workflow (row controls, status, Open)  
4. Ports, conflicts, and recovery (differentiator — keep prominent)  
5. **Also useful** (or keep section titles but move later): organize (profiles/tags/groups), stacks/Compose/import, browser/phone extras, agents  

Claim accuracy rules in `test/readme.test.js` stay in force; rewrite tests with the new structure rather than weakening claim gates.

**Gallery**

| Slot | Intent |
| --- | --- |
| gallery-01-hero | **Do not change.** Keep the current README / Marketplace hero still as shipped. |
| gallery-02-status | Optional refresh only if needed for accuracy; not required for 0.1.0 |
| gallery-03-features | Optional empty-state chrome cleanup only if low-cost; not required for 0.1.0 |

No gallery regen is part of the focus package unless a separate explicit decision says otherwise.

**Category**

- Remain `Other` unless Marketplace docs allow a clearly better single category without lying about scope. Document the check in the implementation plan; do not invent a category.

### 5. What does not change

- Process tree stop defaults, external-listener confirmation + revalidation, multi-window ownership.
- Stack / Compose / transfer review-before-run semantics.
- Agent setup requiring review before a new project can start.
- No new production dependencies for this package.

## Version bars

### Current: `0.0.17`

Public early release. Engineering mature; Marketplace signal still “pre-1.0 / unfinished.”

### `0.1.0` — Focus release (this package’s target)

Ship `0.1.0` when **all** are true:

1. Tracks A–C above are merged and Marketplace-validated.
2. Core loop for a common local Node/`npm run dev` (or equivalent) path works on Windows, macOS, and Linux CI/smoke you already run.
3. README above-the-fold sells that loop; advanced features are present but not equal-weight in the first screen of reading.
4. First add does not confront the user with the full advanced form.
5. `npm run verify` and `npm run package` pass; tracked VSIX matches source per existing gates.
6. CHANGELOG describes focus/clarity — not “removed features.”

`0.1.0` means: **we are confident strangers can succeed at the core job.** It does not mean every edge case or remote scenario is done.

### Between `0.1.x` and `1.0.0`

Use `0.1.x` / `0.2.x` for:

- Core-loop bugfixes and recovery-copy polish
- Platform-specific Start/Stop footguns
- Small clarity tweaks from real user feedback
- Optional: fix unsupported-host messaging without expanding support

Avoid using that band for large new product surfaces unless users pull hard.

### `1.0.0` — Public promise

Ship `1.0.0` when **all** are true:

1. **Stood-behind core loop** — Start / Stop / status / Open / busy-port recovery work reliably for the documented supported hosts on Win/macOS/Linux for the common project shapes you claim (at minimum: single-folder app with a start command and optional port).
2. **No known footguns you’d be embarrassed to own** — especially wrong process kill, false “other window” ownership, or silent status lies. Track blockers explicitly; do not ship 1.0 with an open P0 in lifecycle/ports.
3. **Storage & behavior stability** — project document / stack contract migrations are backward compatible or have a documented one-way migrate; you are willing to treat breaking persisted shape as a major bump after 1.0.
4. **Documented limits are intentional** — remote SSH, Dev Containers, Codespaces, tunnels, WSL network-path Start limits are either fixed or clearly permanent product boundaries in README (not “oops”).
5. **External proof** — at least a small set of real users (or equivalent dogfood outside yourself) has completed the core loop without hand-holding; serious bug reports from that use are addressed or accepted as known limits.
6. **Marketplace honesty** — README claims ≤ shipped behavior; version `1.0.0`; gallery matches the product users install.

**What 1.0.0 is not**

- Not “every feature equally polished.”
- Not “agents/MCP are the lead story.”
- Not “works in every remote VS Code topology.”
- Not “feature freeze forever” — minors after 1.0 can still add advanced power, as long as the core promise stays true.

## Success metrics (lightweight, indie-realistic)

- Time-to-first-Ready for a seeded demo folder drops friction (qualitative: under a minute without docs).
- Support/issues skew toward edge cases, not “what do I click first?”
- Marketplace listing skim test: a cold reader can state the product job after the first screen.

## Risks

| Risk | Mitigation |
| --- | --- |
| Progressive disclosure hides a field power users need on first add | More options one click away; Edit shows all used fields |
| README rewrite breaks claim tests | Update tests in same PR; keep fail-closed overclaim rules |
| Post-install tip feels spammy | Once per install via globalState; only when project list empty |
| Gallery regen drift | N/A — hero (and optional stills) stay as shipped unless separately requested |
| Scope creep into remote Start | Explicit non-goal |

## Approval

Approve this design to proceed with the implementation plan in `docs/superpowers/plans/2026-08-28-focus-strengthening.md`.
