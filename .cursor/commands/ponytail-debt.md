---
name: ponytail-debt
description: Harvest ponytail: comments into a debt ledger
---

# /ponytail-debt

Harvest every `ponytail:` comment in this repository into a debt ledger.

Grep the tree for `# ponytail:` / `// ponytail:` (skip node_modules/.git/build). One row per marker, grouped by file:
`<file>:<line> — <what was simplified>. ceiling: <limit>. upgrade: <trigger>.`

Tag markers with no upgrade path as `no-trigger`. End with counts. If none: `No ponytail: debt. Clean ledger.`
Report only — change nothing.
