---
name: ponytail-review
description: Review current changes for over-engineering (what to delete)
---

# /ponytail-review

Review the current code changes for over-engineering only, not correctness.

One line per finding: `L<line>: <tag> <what to cut>. <replacement>.`

Tags:
- `delete:` dead code / unused flexibility / speculative feature
- `stdlib:` reinvented standard library — name the function
- `native:` dependency doing what the platform already does
- `yagni:` abstraction with one implementation, config nobody sets
- `shrink:` same logic, fewer lines — show the shorter form

End with net lines removable. If nothing to cut: `Lean already. Ship.`
Do not apply fixes — report only.
