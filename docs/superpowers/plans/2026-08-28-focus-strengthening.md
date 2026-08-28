# Focus strengthening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every Runlist feature, but make the core loop and Marketplace story unmistakable, then ship that package as `0.1.0` with an explicit bar for a future `1.0.0`.

**Architecture:** Attention changes only — progressive disclosure on first-add UI, empty-state/chip clarity, one-time post-install tip, README/gallery/keyword hierarchy. No lifecycle/ownership semantic changes. Advanced features stay in Edit, project More, and global `⋯`.

**Tech Stack:** Existing VS Code extension webview (`media/main.js`, `media/styles.css`), host (`src/host/runlist-view-provider.js`, `extension.js`), Marketplace assets (`README.md`, `package.json`, `media/gallery-*.png`), Node test suite under `test/`.

**Spec:** `docs/superpowers/specs/2026-08-28-focus-strengthening-design.md`

## Global Constraints

- Keep all currently implemented features; do not delete or feature-flag them off.
- Do not change extension version until Task 7 (`0.1.0`); do not invent `1.0.0` in this package.
- Do not add production dependencies.
- Do not weaken fail-closed README overclaim rules.
- Do not put product marketing essays in the empty-state webview (`test/webview-list-density.test.js`).
- Preserve process/port safety and multi-window ownership behavior.
- On Linux verify with `xvfb-run -a npm run verify` when smoke needs a display; always `npm run package` before finish.
- Branch naming for implementation work: `cursor/<descriptive-name>-9c97` if starting fresh from main.

## File map

| File | Role in this plan |
| --- | --- |
| `media/main.js` | Empty state, add-form progressive disclosure, chip labels |
| `media/styles.css` | More-options / empty-state density |
| `src/host/runlist-view-provider.js` | Unsupported-host messaging timing if moved; reveal helpers |
| `extension.js` | Optional one-time open tip on activate |
| `README.md` | Marketplace hierarchy rewrite |
| `package.json` | Keywords; version only in Task 7 |
| `CHANGELOG.md` | 0.1.0 notes in Task 7 |
| `media/gallery-0{1,2,3}-*.png` | Gallery intent refresh |
| `test/webview-list-density.test.js` | Empty-state copy contracts |
| `test/empty-start-chips.test.js` | Chip behavior/label contracts |
| `test/webview-render-runtime.test.js` | Add-form field visibility |
| `test/readme.test.js` | README structure/claims |
| `test/marketplace-readiness.test.js` | Keywords / metadata |
| `test/current-workspace-onboarding.test.js` | Reveal / tip wiring if touched |
| `test/first-add-progressive-disclosure.test.js` | First-add More options contracts |
| `test/open-runlist-tip.test.js` | One-time install tip contracts |

---

### Task 1: Lock add-form progressive disclosure with failing tests

**Files:**
- Create: `test/first-add-progressive-disclosure.test.js`
- Modify: `media/main.js` (later task)
- Test: `test/first-add-progressive-disclosure.test.js`
- Reference: `test/webview-render-runtime.test.js` (`hides launch profiles on first add when only Default exists`)

**Interfaces:**
- Consumes: existing webview render of `state.mode === 'add'` draft HTML in `media/main.js`
- Produces: test contracts that first-add always shows folder + start command + Save; advanced fields live under a collapsed More options region; edit mode still surfaces advanced fields when present

- [ ] **Step 1: Write the failing test file**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webview = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

test('first add keeps folder and start command outside More options', () => {
  assert.match(webview, /id="folder"/);
  assert.match(webview, /id="start-command"/);
  assert.match(webview, /More options/);
  // Advanced fields must be referenced inside a details/summary More options block for add mode.
  assert.match(
    webview,
    /<details class="more-options">[\s\S]*<summary>[\s\S]*More options[\s\S]*<\/summary>[\s\S]*id="local-hostname"[\s\S]*id="tags"[\s\S]*id="stop-command"[\s\S]*id="env-file"/
  );
});

test('first add does not require opening More options to save', () => {
  assert.match(webview, /Save project/);
  assert.match(webview, /id="project-form"/);
});
```

Adjust selectors to match the exact markup you implement in Task 2; keep the intent: collapsed advanced block on add.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/first-add-progressive-disclosure.test.js`  
Expected: FAIL (More options / details markup absent)

- [ ] **Step 3: Commit the failing test**

```bash
git add test/first-add-progressive-disclosure.test.js
git commit -m "test: require More options progressive disclosure on first add"
```

---

### Task 2: Implement first-add More options disclosure

**Files:**
- Modify: `media/main.js` (add-screen form ~1824–1900+)
- Modify: `media/styles.css` (compact `details.more-options` matching existing sidebar density)
- Modify: `test/webview-render-runtime.test.js` if render snapshots assert field order
- Test: `test/first-add-progressive-disclosure.test.js`, `test/webview-render-runtime.test.js`

**Interfaces:**
- Consumes: `state.mode` (`add` | `edit` | review), `state.draft`, existing `showLaunchProfileEditor`
- Produces: On `add` (non-review), wrap name, local hostname, tags, stop, env file, env overrides, and services editor in `<details class="more-options">` default collapsed. On `edit` / reviewing, either omit the wrapper or render `open` when any advanced field is non-empty so existing data stays visible.

- [ ] **Step 1: Implement the wrapper in `media/main.js`**

Pattern (adapt to existing template literals):

```js
const isFirstAdd = state.mode === 'add' && !reviewing;
const advancedOpen = !isFirstAdd || Boolean(
  state.draft.localHostname
  || state.draft.tags
  || activeProfile.stopCommand
  || activeProfile.envFile
  || activeProfile.envText
  || (activeProfile.services || []).length
);
// Render primary: folder, start command (+ draft chips), then:
// <details class="more-options" ${advancedOpen ? 'open' : ''}>
//   <summary>More options</summary>
//   ... name, hostname, tags, stop, env, services ...
// </details>
```

Keep launch-profile hide-on-first-add behavior unchanged.

- [ ] **Step 2: Add minimal CSS**

```css
.more-options {
  margin: 8px 0 12px;
}
.more-options > summary {
  cursor: pointer;
  list-style: none;
  color: var(--vscode-descriptionForeground);
}
```

Match existing spacing; no card chrome.

- [ ] **Step 3: Run tests**

Run: `node --test test/first-add-progressive-disclosure.test.js test/webview-render-runtime.test.js test/launch-profile-ui.test.js`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add media/main.js media/styles.css test/first-add-progressive-disclosure.test.js test/webview-render-runtime.test.js
git commit -m "feat: collapse advanced fields under More options on first add"
```

---

### Task 3: Clarify empty-state Start/Dev chips (save+start vs fill)

**Files:**
- Modify: `media/main.js` (empty-state chip `title` / `aria-label` ~1030–1038)
- Modify: `test/empty-start-chips.test.js`
- Do **not** change `startWorkspaceScript` behavior unless a separate approved issue says so

**Interfaces:**
- Consumes: `start-workspace-script` action → host `startWorkspaceScript` (upsert + `startProject`)
- Produces: Labels that state save-and-start intent; form chips remain fill-only

- [ ] **Step 1: Update failing assertions in `test/empty-start-chips.test.js`**

Require aria-label / title text that includes both the command and that Runlist will save and start, e.g. match:

```js
assert.match(webview, /Save and start \\`\$\{script\.startCommand\}\\` for this folder/);
```

Keep form-chip test asserting fill-only (`useDraftStartScript`, no `startProject`).

- [ ] **Step 2: Run to verify fail, then update empty-state chip strings in `media/main.js`**

```js
const chipHint = `Save and start \`${script.startCommand}\` for this folder`;
```

- [ ] **Step 3: Run tests**

Run: `node --test test/empty-start-chips.test.js test/webview-list-density.test.js`  
Expected: PASS (still no marketing essay on empty state)

- [ ] **Step 4: Commit**

```bash
git add media/main.js test/empty-start-chips.test.js
git commit -m "fix: clarify empty-state Start/Dev chips save and start"
```

---

### Task 4: One-time post-install Open Runlist tip

**Files:**
- Modify: `extension.js` (`activate`)
- Create: `test/open-runlist-tip.test.js`
- Modify: `test/current-workspace-onboarding.test.js` only if reveal helper contracts need sharing

**Interfaces:**
- Consumes: `context.globalState`, existing reveal pattern from `revealRunlistView` / `workbench.view.extension.runlist`
- Produces: At most one tip per profile when projects storage is empty; action opens Runlist

- [ ] **Step 1: Write failing test**

Assert `extension.js` (or provider) contains:

- globalState key `runlist.didShowOpenTip`
- `showInformationMessage` with Open Runlist action
- does not run when projects already exist (check projects file / store length)

Source-scan style like other activation tests is fine.

- [ ] **Step 2: Implement in `activate` after provider registration**

Use existing `provider.revealRunlistView()` (`src/host/runlist-view-provider.js`). Read project count from the same store the provider already loads (empty `projects` array ⇒ tip eligible).

```js
const TIP_KEY = 'runlist.didShowOpenTip';
if (!context.globalState.get(TIP_KEY) && provider.projects.length === 0) {
  void vscode.window.showInformationMessage(
    'Open Runlist to save and control local apps.',
    'Open Runlist'
  ).then(async (choice) => {
    await context.globalState.update(TIP_KEY, true);
    if (choice === 'Open Runlist') {
      await provider.revealRunlistView();
    }
  });
}
```

Mark tip shown on Dismiss too (any close of the message) so it is truly once. Confirm `provider.projects` is the public in-memory list already maintained on the provider; if the field is private-named differently, use the same accessor `showAddProject` / render path uses — do not invent a second store read.

- [ ] **Step 3: Run tests**

Run: `node --test test/open-runlist-tip.test.js test/project-storage-activation.test.js test/current-workspace-onboarding.test.js`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add extension.js test/open-runlist-tip.test.js
git commit -m "feat: one-time tip to open Runlist after install"
```

---

### Task 5: Marketplace README hierarchy + keyword trim

**Files:**
- Modify: `README.md`
- Modify: `test/readme.test.js`
- Modify: `package.json` (keywords only)
- Modify: `test/marketplace-readiness.test.js`

**Interfaces:**
- Consumes: shipped behavior only; no new claims
- Produces: Above-the-fold = core loop + ports; advanced sections later under clear “also useful” hierarchy; keywords stay core-led

- [ ] **Step 1: Rewrite README structure**

Order:

1. `# Runlist` + tagline + 4–5 **core** bullets + `gallery-01`
2. `## Get started`
3. `## Everyday workflow` + `gallery-02`
4. `## Ports, conflicts, and recovery`
5. `## Also useful` (or keep existing H2 titles but move after core): organize / stacks / browser-or-phone — must still mention profiles, tags, groups, Load stack, Import or Export, Compose, phone QR, agents overflow so claim tests can be updated without deleting feature documentation
6. Closing Marketplace link + publisher line
7. Empty-state still: `gallery-03` near Get started or after it

Keep fail-closed overclaim bans from `test/readme.test.js`.

- [ ] **Step 2: Update `test/readme.test.js`**

- Keep gallery path/alt/dimension checks; update section order assertions.
- Allow a single “Also useful” parent **or** assert advanced H2s appear **after** Ports section.
- Remove obsolete assertions that force advanced sections to appear as early peer pillars if you change headings — replace with “documented after core” assertions.

- [ ] **Step 3: Trim keywords in `package.json`**

Keep first five core-focused. Remove or demote `coding agents` / `mcp` from the keyword array (product remains; search noise drops). Update `marketplace-readiness.test.js` accordingly.

- [ ] **Step 4: Run tests**

Run: `node --test test/readme.test.js test/marketplace-readiness.test.js test/readme-named-urls-claims.test.js test/readme-stack-contract-claims.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md package.json test/readme.test.js test/marketplace-readiness.test.js
git commit -m "docs: lead Marketplace listing with core loop; demote advanced noise"
```

---

### Task 6: Gallery refresh for simple-first story

**Files:**
- Modify: `media/gallery-01-hero.png` (and 02/03 if needed)
- Modify: `README.md` alts only if copy changes
- Scripts: `npm run update:webview-screenshot` / `scripts/compose-gallery-hero.js` as used in-repo today
- Test: `test/readme.test.js` gallery dimension contracts

**Interfaces:**
- Consumes: existing capture pipeline
- Produces: hero = simple everyday list (few projects, Running, Open); status shot clarity; empty-state without Extension Development Host chrome when capture environment allows

- [ ] **Step 1: Capture / compose new stills per design table**

Prefer regenerating over hand-editing binaries. Keep width ≥ 1000 and height ≥ 700 per readme tests.

- [ ] **Step 2: Run**

Run: `node --test test/readme.test.js`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add media/gallery-01-hero.png media/gallery-02-status.png media/gallery-03-features.png README.md
git commit -m "media: refresh Marketplace gallery for simple-first story"
```

---

### Task 7: Unsupported-host copy timing

**Files:**
- Modify: `media/main.js` (empty-state block that prints when `state.lifecycleWindowSupported === false`)
- Modify: `test/webview-list-density.test.js` and any empty-state test that asserts the long remote paragraph on empty state
- Optional host: only if Start path needs a message when empty-state text is removed — `src/host/runlist-view-provider.js` Start preflight

**Interfaces:**
- Consumes: `state.lifecycleWindowSupported === false`
- Produces: Empty state keeps one short secondary sentence at most; full topology list moves to Start failure / warning when the user actually tries to start in an unsupported window

- [ ] **Step 1: Write / update tests**

Empty state may still mention that Start/Stop need this computer, but must not dump the full SSH/Dev Containers/Codespaces/Tunnels/WSL list as the primary empty paragraph for every user. Assert the long list appears in the Start warning path (search host for existing unsupported-window messaging and attach there if missing).

- [ ] **Step 2: Implement**

Remove or shorten the empty-state paragraph currently rendered at ~line 1025 in `media/main.js`. Ensure Start in an unsupported window still surfaces the full clear explanation (reuse existing capability checks).

- [ ] **Step 3: Run**

Run: `node --test test/webview-list-density.test.js test/lifecycle-capability.test.js`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add media/main.js src/host/runlist-view-provider.js test/webview-list-density.test.js
git commit -m "fix: defer unsupported-host explanation until Start"
```

If Start-path messaging is already complete and empty-state-only change is enough, skip host file in the commit. If this task flakes smoke or fights density contracts, skip entirely and file as `0.1.x` follow-up — do not block Task 8.

---

### Task 8: Version `0.1.0`, changelog, package gates

**Files:**
- Modify: `package.json` version → `0.1.0`
- Modify: `package-lock.json` if it embeds version
- Modify: `CHANGELOG.md` new top section
- Modify: `README.md` only if it asserts a version (prefer not)
- Run packaging scripts; refresh `releases/runlist.vsix` per repo convention

**Interfaces:**
- Consumes: completed Tasks 1–6 (and 7 if done)
- Produces: publishable `0.1.0` artifact that passes existing Marketplace validators

- [ ] **Step 1: Update CHANGELOG**

```md
## 0.1.0 — Focus the core loop

- Collapse advanced Add fields under More options so first save is folder + start command.
- Clarify empty-state Start/Dev chips save and start the folder.
- Show a one-time tip to open Runlist after install when the list is empty.
- Lead the Marketplace README and gallery with everyday Start/Stop/Open; keep advanced features documented later.
- Trim Marketplace keyword noise; agents/MCP remain available from More.
```

- [ ] **Step 2: Bump version to `0.1.0` in `package.json` (+ lockfile if needed)**

- [ ] **Step 3: Verify and package**

```bash
xvfb-run -a npm run verify
npm run package
```

Expected: verify ends successfully including `Runlist extension-host smoke suite passed.`; package writes validated VSIX.

- [ ] **Step 4: Commit + push**

```bash
git add package.json package-lock.json CHANGELOG.md releases/runlist.vsix
git commit -m "release: 0.1.0 focus the core loop"
git push -u origin HEAD
```

Do **not** publish to Marketplace or merge to `main` from the agent unless explicitly asked. Leave Ops/`docs/marketplace-release.md` path for humans.

---

## After 0.1.0 — path to `1.0.0` (checklist, not this PR)

Track as issues; do not implement in the focus package unless they are blockers discovered during verify:

1. P0 lifecycle/port footguns closed (wrong kill, false ownership, dishonest status).
2. Supported-host matrix for the README claim set green on Win/macOS/Linux.
3. Persisted project/stack schema treated as compatibility-stable (migrate, don’t break quietly).
4. Remote/unsupported limits fixed **or** documented as permanent boundaries.
5. Small external user proof of the core loop; serious reports addressed.
6. Marketplace listing still claim-accurate; then bump to `1.0.0` with changelog that states the promise.

---

## Self-review

| Spec item | Task |
| --- | --- |
| Keep all features | Global constraint; Tasks 2/5 demote attention only |
| First-add progressive disclosure | Tasks 1–2 |
| Empty-state chip clarity | Task 3 |
| Post-install tip | Task 4 |
| README / keywords / gallery | Tasks 5–6 |
| Unsupported-host timing | Task 7 (optional) |
| 0.1.0 ship bar | Task 8 |
| 1.0.0 bar defined | Spec + After 0.1.0 section |

No intentional placeholders. Category remains `Other` unless a documented Marketplace rule change appears during Task 5 — check once, don’t invent.
