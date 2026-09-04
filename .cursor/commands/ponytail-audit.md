---
name: ponytail-audit
description: Audit the whole repo for over-engineering
---

# /ponytail-audit

Audit the entire repository for over-engineering only, not correctness. Scan the whole tree, not a diff.

One line per finding, ranked biggest cut first:
`<tag> <what to cut>. <replacement>. [path]`

Tags: `delete`, `stdlib`, `native`, `yagni`, `shrink` (same meanings as /ponytail-review).

End with: `net: -<N> lines, -<M> deps possible.`
If nothing to cut: `Lean already. Ship.`
Do not apply fixes — one-shot report only.
