---
name: ponytail-help
description: >
  Quick-reference card for all ponytail modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /ponytail-help,
  "ponytail help", "what ponytail commands", "how do I use ponytail".
disable-model-invocation: true
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | `/ponytail lite` | Build what's asked, name the lazier alternative in one line. |
| **Full** | `/ponytail` | The ladder enforced: YAGNI → stdlib → native → one line → minimum. Default. |
| **Ultra** | `/ponytail ultra` | YAGNI extremist. Deletion before addition. Challenges requirements before building. |

Level sticks until changed or session end.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail` | Lazy mode itself. Simplest solution that works. |
| **ponytail-review** | `/ponytail-review` | Over-engineering review: `L42: yagni: factory, one product. Inline.` |
| **ponytail-audit** | `/ponytail-audit` | Whole-repo over-engineering audit: ranked list of what to delete. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `ponytail:` shortcut comments into a tracked ledger. |
| **ponytail-gain** | `/ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/ponytail-help` | This card. |

Codex uses `@ponytail`, `@ponytail-review`, and `@ponytail-help`; Claude Code
and OpenCode use the slash-command forms above (OpenCode ships all six as
slash commands).

## Deactivate

Say "stop ponytail" or "normal mode". Resume anytime with `/ponytail`.
`/ponytail off` also works for the current session.

## Activation in Cursor

In this repo, ponytail is **always active** via `.cursor/rules/ponytail.mdc`
(`alwaysApply: true`). Every new Agent chat starts in **full** mode.

`PONYTAIL_DEFAULT_MODE` and `~/.config/ponytail/config.json` are **not**
supported in Cursor — those controls exist only on hosts with ponytail lifecycle
hooks (Claude Code, Codex, OpenCode, etc.). To change intensity here, use
`/ponytail lite|full|ultra`. To pause for the session, say "stop ponytail".

## Update

Cursor has no `/plugin` marketplace. Refresh the installed adapter from
[upstream ponytail](https://github.com/DietrichGebert/ponytail) and copy the
updated `.cursor/rules/` and `.cursor/skills/` files into this repo.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
