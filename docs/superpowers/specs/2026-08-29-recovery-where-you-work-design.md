# 0.1.7 — Recovery where you already work

**Status:** Draft for review  
**Date:** 2026-08-29  
**Milestone theme:** Terminal-native recovery, honest agent handoff, core-loop polish  
**Builds on:** 0.1.5/0.1.6 (MCP status + Ask your agent), 0.1.3 (View output primaries), 0.1.4 (find/fix)

---

## Summary

When something goes wrong, Runlist should put nontechnical users in the right place with honest guidance:

1. **Terminal-native (A)** — Start output lives in a named VS Code terminal tab; **Show terminal** replaces **View output** for humans.
2. **Agent honesty (B)** — Separate “skill installed” from “ready for handoff”; direct chat handoff only when Copilot/VS Code chat is actually available.
3. **Core loop polish (C)** — Confirm Stop group, Review setup filter, Copy error from the row.

**Stop scope for 0.1.7:** Start-only in the run terminal (A1). Stop mechanics unchanged; recovery UX routes to the start terminal + existing failure surfaces. Custom stop-in-terminal deferred to 0.1.8.

---

## Goals

- Humans read live and recent Start output in VS Code’s native terminal (scrollback, copy, split panels).
- Lifecycle ownership, port safety, and `docs/lifecycle-contract.md` invariants are preserved.
- Bounded, redacted capture continues to feed row summaries, retained diagnostics, and MCP tools.
- Agent connections and **Ask your agent** copy match real behavior (no “connected” when only a skill exists on disk).
- Small friction cuts ship alongside the headline change without scope creep.

## Non-goals

- MCP start/stop/restart/close-port tools.
- Auto-sending failures to agents without explicit user action.
- Agent-applied repairs without sidebar approval.
- Running custom Stop commands in the run terminal (0.1.8 follow-up).
- Replacing retained diagnostics or the agent repair proposal flow.
- Unbounded log retention or log search.
- New production dependencies.
- Version/changelog/VSIX edits in feature PRs (release PR only).

---

## User problems

### Terminal (parent #358)

**View output** is a sidebar webview log viewer. VS Code already has integrated terminals with scrollback, search, and copy. Nontechnical users are sent to a duplicate surface when Start fails or a service is not responding.

**Open terminal here** opens an empty shell — not the output from the run that failed.

### Agent handoff (0.1.5 follow-up)

`initialAgentConnection()` marks an agent **Ready** (`status: 'success'`) when the Runlist skill exists on disk, even if the user never pressed **Set up** in this session. **Ask your agent** can open chat when the UI implied no connection was established.

Handoff uses `workbench.action.chat.open` (Copilot/VS Code chat only). Codex and Claude skill setup does not imply chat handoff works — copy must stay honest.

### Core loop polish

- **Stop group** stops multiple projects with one click and no confirmation (#337; **Stop all** already confirms).
- After import/load stack, review-required projects are counted but not filterable (#339).
- Start/stop errors require expanding Output or diagnosis to copy (#320, #321).

---

## Solution overview

| Pillar | User-visible change | Under the hood |
| --- | --- | --- |
| **A — Terminal-native** | **Show terminal** on row; named tab `Runlist · {name}` | Piped spawn + ownership unchanged; output mirrored to ExtensionTerminal PTY |
| **B — Agent honesty** | **Ready for handoff** vs **Skill installed** on Agent connections | `hasConnectedAgent` / handoff gating use explicit handoff-ready state |
| **C — Polish** | Confirm Stop group; Review setup filter; Copy error | Webview filter + host clipboard helpers |

### Ship order (one milestone, layered PRs)

1. **C** — independent, low risk  
2. **B** — honest agent state before recovery copy changes  
3. **A** — headline; updates skill/README/agent copy to **Show terminal**  
4. **Release PR** — 0.1.7 changelog, `npm run package`, Marketplace

---

## Part A — Terminal-native (Start only)

### UX

#### Start

1. User presses **Start**.
2. Runlist creates or reuses a VS Code terminal named **`Runlist · {project name}`** with `cwd` = saved folder.
3. The start command and live output appear in that tab (see implementation strategy below).
4. Row lifecycle (starting → running / failed) is unchanged.

#### Show terminal (replaces View output for humans)

Primary row action when today’s primary is `output`:

| Situation | Today | 0.1.7 |
| --- | --- | --- |
| Generic start failure | View output | **Show terminal** |
| Stop failure (process/port still up) | View output | **Show terminal** |
| Web service not responding | View output | **Show terminal** |

- **Show terminal** focuses the project’s run terminal (`Runlist · {name}`).
- Accessible name: `Show terminal for {name}`.
- `data-action`: `show-terminal` (replaces `output` for these primaries).

#### Open terminal here (unchanged)

More menu → blank shell in project folder for manual debugging. Not tied to lifecycle.

#### Fallback when no run terminal exists

(e.g. detected/external process, terminal disposed, remote edge case)

- **Show terminal** is disabled **or** falls back to **Open terminal here** with clear copy:  
  `No Runlist run terminal for {name}. Open a blank terminal in this folder?`
- Pick one behavior in implementation; test both remote-blocked and detected rows.

#### Expanded row output peek

- Slim to a short bounded excerpt **or** remove if the run terminal is the primary path.
- If a peek remains, **Show terminal** is still the primary path to full logs.
- Deprecate full-screen `output-screen` route for ordinary user recovery (diagnosis screen may still link to output context for agents — keep if needed for **Copy diagnosis request** fallback).

### Implementation strategy (ownership-safe)

**Do not** run Start only via `Terminal.sendText` into a real shell without a verified ownership path — that breaks PID tracking and `docs/lifecycle-contract.md`.

**Recommended:** keep existing `spawnProjectCommand` + piped stdio + `listenToProjectOutput` for ownership and capture. Mirror output into a VS Code **ExtensionTerminal** (PTY) per project:

```
Start pressed
  → spawnProjectCommand (piped, supervisor, ownership)  [unchanged authority]
  → create/reuse ExtensionTerminal "Runlist · {name}"
  → on open: write prompt line "$ {startCommand}\n" to PTY
  → on each output chunk: pty.write(chunk)  [preserve ANSI when present]
  → bounded ring buffer still feeds addProjectOutput / diagnostics
```

**Alternatives considered:**

| Approach | Pros | Cons |
| --- | --- | --- |
| Real terminal + `sendText` only | Simple | Loses reliable PID/ownership; violates contract |
| Pipe only (today) | Safe | No terminal UX |
| **PTY mirror (chosen)** | Native tab + safe ownership | No true TTY for child (acceptable; most dev servers work) |
| Duplicate spawn (terminal + pipe) | — | Two processes; rejected |

Store terminal reference per project id in host (`runTerminals: Map<id, Terminal>`). Reuse on Restart; dispose on project delete with clear orphan-tab policy (leave tab open, don’t auto-kill user’s terminal).

### Capture and agents (unchanged contract)

- `addProjectOutput`, `failureSummary`, `readProjectDiagnostics`, `runlist_get_project_diagnostics` retain bounded redacted payloads.
- MCP tools remain read-only; no new tools.
- Update `skills/runlist/SKILL.md` and README: humans use **Show terminal**; agents still use MCP diagnostics.

### Compose / lifecycle-blocked

- No terminal run where Start is already blocked (`lifecycleBlocked`, `reviewRequired`, unsupported host).
- Compose-managed projects follow existing argv/env gating.

---

## Stop handling (A1 — explicit)

Stop **mechanics do not change** in 0.1.7. Recovery **routing** changes.

### Path 1 — Default Stop (no custom stop command)

Runlist stops the owned process tree via `terminateProcessTree`. No user command, no log surface required.

- Row: Stopping… → Stopped.
- Start terminal may show the app exiting if it was printing there.

### Path 2 — Custom Stop command

Still spawned with `customStopSpawnOptions()` (piped, background). Last ~2KB stdout/stderr captured inside `runCustomStopCommand` for failure messages.

- **Not** shown in the run terminal in 0.1.7.
- Failure: native VS Code error toast + row `stopFailure` text (unchanged).

### Path 3 — Stop failure recovery

| Need | Surface |
| --- | --- |
| What was the app doing? | **Show terminal** → start run terminal |
| Why did Stop fail? | Row line 2 + error toast |
| Paste for ticket/chat | **Copy error** (C, #321) |
| Agent help | **Ask your agent** + MCP (unchanged) |

**View output** today on stop failure mostly shows **start** capture anyway — **Show terminal** is equivalent or better for that context.

### 0.1.8 follow-up (A2)

Run saved **Stop** command in `Runlist · {name}` via PTY mirror or verified `sendText` once Start-in-terminal is stable on Windows, macOS, Linux, and remote hosts.

---

## Part B — Agent honesty

### States

Replace single `success` = “Ready” with two concepts on Agent connections:

| State | Meaning | UI label |
| --- | --- | --- |
| **Skill installed** | Runlist skill files present on disk | Skill installed |
| **Ready for handoff** | User completed **Set up** successfully this session **or** persisted handoff-ready flag **and** VS Code chat handoff API available | Ready for handoff |

**Fix:** `initialAgentConnection()` must **not** return `status: 'success'` solely because `agentSkillStatus().status === 'installed'`. On load:

- `installed` → `{ status: 'installed', message: '…' }` (new status or reuse `idle` with distinct message)
- After successful **Set up** registration → `{ status: 'success', … }` (handoff-ready)

### Handoff gating

- `hasConnectedAgent()` → rename conceptually to `hasHandoffReadyAgent()`: true only when at least one agent has `status === 'success'` from explicit setup (not disk-only install).
- `askAgentForDiagnosis()`: direct handoff only when handoff-ready **and** `workbench.action.chat.open` is appropriate (Copilot/VS Code chat).
- Otherwise: diagnosis screen + **Copy diagnosis request** + link to Agent connections.

### Copy updates

- `media/main.js` Agent connections screen:
  - **Skill installed** ≠ **Ready for handoff**
  - Direct handoff: **GitHub Copilot / VS Code chat only** (not Codex CLI, not Claude Code alone)
  - Cursor: same VS Code MCP path as today
- `skills/runlist/SKILL.md`: replace **View output** references with **Show terminal** where describing human log reading.
- `README.md`: one honest line under agent area if behavior changes.

### Out of scope for B

- Codex/Claude-specific chat routing APIs.
- **Ask your agent** without retained failure diagnostics.
- New agent providers.

---

## Part C — Core loop polish

### C1 — Confirm Stop group (#337)

Before `lifecycle.stopGroup(id)`:

- Modal: `Stop group {name}?`
- Detail: counts stoppable members; names bounded (first 8 + “and N more”); clarifies skipped/external/already-stopped members.
- Actions: **Stop group** / Cancel.
- Cancel: zero stops; restore group button state (no stuck busy).
- Recompute stoppable set at confirm time via existing `stoppableProjectIds` / `stopGroupOperation` rules.

### C2 — Review setup filter (#339)

When `reviewCount > 0`:

- Show **Review setup (N)** chip (match tag/group chip patterns).
- Toggle filters to `project.reviewRequired === true`.
- **Clear filters** clears review filter with search/tag/group.
- Persist in webview state (`saveWebviewState`).
- Auto-hide when count → 0.

### C3 — Copy error (#320, #321)

More menu item **Copy error** when:

- Stopped row with `failureSummary` (start failure), **or**
- Row with `stopFailure` while still running/stopping (stop failure path).

Host builds redacted plain text (reuse `redactProjectOutputText` / diagnosis bounds):

```
Runlist start failed — {name}
{title}
{message}

Recent output:
{bounded snippet or (no output captured)}
```

Stop variant uses stop failure detail + relevant capture.

- Confirmation: `Copied start error for {name}.` / `Copied stop error for {name}.`
- Does not open diagnosis, MCP, or browser.

---

## Acceptance criteria

### A — Terminal-native

- [ ] Start creates/reuses `Runlist · {name}` terminal with correct `cwd`.
- [ ] Live start output visible in that terminal tab during run.
- [ ] **Show terminal** replaces **View output** as row primary for start fail, stop fail, and not-responding cases.
- [ ] **Open terminal here** unchanged (blank shell).
- [ ] Bounded redacted capture still feeds row summaries and `runlist_get_project_diagnostics`.
- [ ] Process ownership and `docs/lifecycle-contract.md` scenarios pass existing native/unit coverage.
- [ ] Compose/lifecycle-blocked gating unchanged.
- [ ] Windows, macOS, Linux; remote hosts degrade safely.

### B — Agent honesty

- [ ] Skill on disk alone does not enable direct handoff.
- [ ] Explicit **Set up** success marks handoff-ready for that agent.
- [ ] **Ask your agent** opens chat when handoff-ready; otherwise diagnosis + copy fallback.
- [ ] Agent connections UI distinguishes installed vs handoff-ready.
- [ ] Copy does not claim Codex/Claude chat handoff.

### C — Polish

- [ ] Stop group confirmation modal; cancel performs zero stops.
- [ ] Review setup filter chip; clear filters resets it.
- [ ] Copy error in More menu with redaction and bounds.

### Release (0.1.7)

- [ ] All pillar PRs merged.
- [ ] `xvfb-run -a npm run verify` + `npm run package` on Linux.
- [ ] README/skill accurately describe Show terminal + handoff limits.

---

## Cross-platform requirements

- **PTY terminal:** VS Code ExtensionTerminal API on Windows, macOS, Linux.
- **Remote SSH / Dev Containers:** terminal in remote extension host; no false local PID claims when lifecycle blocked.
- **Multi-window:** each window owns its run terminals and capture buffers; stopping in one window does not assume tabs in another.
- **WSL:** follow VS Code terminal cwd/path semantics.
- **Agent handoff:** `workbench.action.chat.open` with graceful fallback when unavailable (web, unsupported).

---

## Testing requirements

1. **A:** Host tests — terminal create/reuse, name, cwd, focus by project id; output chunks reach PTY; ownership tests still pass.
2. **A:** Webview — primary action `show-terminal` for failure fixtures; no regression on two-line row density.
3. **A:** Regression — diagnostics shape, MCP `retainedOutput`, `project-primary-action` cases updated.
4. **B:** `diagnosis-handoff` / host tests — disk install ≠ handoff; setup success enables handoff; fallback on chat command failure.
5. **B:** Agent connections render test — labels for installed vs handoff-ready.
6. **C:** Stop group confirm mock; review filter webview test; clipboard builder redaction tests.
7. Full: `xvfb-run -a npm run verify`, `npm run package`.

---

## Regression risks

| Risk | Mitigation |
| --- | --- |
| Lost PID ownership with terminal launch | PTY mirror only; no sendText-only spawn |
| Duplicate terminals per restart | Reuse map keyed by project id; test Restart |
| Orphan terminal tabs after delete | Document leave-open policy; test dispose |
| Dropped redaction if capture bypassed | Single pipe authority; PTY is write-only mirror |
| Stop failure without terminal context | Show terminal + Copy error + toast (explicit matrix above) |
| Stale handoff-ready across extension updates | Refresh setup path; session vs persisted flag documented in code |
| Review filter stale after approve | Clear when `reviewCount === 0` on render |

---

## Relevant code

| Area | Files |
| --- | --- |
| Start / output | `src/host/runlist-view-provider.js`, `src/lifecycle/project-process.js`, `src/lifecycle/project-lifecycle.js` |
| Terminal | `src/webview/project-navigation.js`, new `src/integrations/run-terminal.js` (suggested) |
| Row actions | `media/project-actions.js`, `media/main.js` |
| Agent handoff | `src/integrations/diagnosis-handoff.js`, `initialAgentConnection`, `askAgentForDiagnosis` |
| Agent UI | `media/main.js` Agent connections |
| Groups | `src/groups/run-groups.js`, `stopSavedRunGroup`, `media/main.js` group filter |
| Filters | `applyProjectFilter`, `clearProjectFilters`, `saveWebviewState` |
| Clipboard | `copyDiagnosisRequest` patterns in `runlist-view-provider.js` |
| Tests | `test/project-primary-action.test.js`, `test/diagnosis-handoff.test.js`, `test/run-groups.test.js`, `test/mcp-server.test.js` |
| Docs | `skills/runlist/SKILL.md`, `README.md`, `CHANGELOG.md` |

---

## Milestone issue map (suggested)

| Issue | Title |
| --- | --- |
| TBD | 0.1.7 milestone: Recovery where you already work |
| TBD | Terminal-native Start + Show terminal (revive #358, A1) |
| TBD | Agent handoff honesty: installed vs ready (#359 follow-up) |
| TBD | Confirm Stop group (#337) |
| TBD | Review setup filter (#339) |
| TBD | Copy error from row (#320, #321) |
| TBD | Release 0.1.7 |

---

## Follow-up: 0.1.8

- **A2:** Custom Stop command in run terminal.
- Optional: VSIX allowlist static check for `require()` gaps (0.1.6 lesson).
