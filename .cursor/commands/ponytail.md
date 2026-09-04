---
name: ponytail
description: Switch ponytail intensity (lite/full/ultra/off), or report current level
---

# /ponytail

Switch to ponytail {{args}} mode. If no level is specified, use full.

Levels:
- `lite` — build what was asked; name the lazier alternative in one line
- `full` — default ladder: YAGNI → stdlib → native → one line → minimum
- `ultra` — deletion before addition; challenge the requirement before building
- `off` — deactivate ponytail for this thread

Before any code: does it need to exist (YAGNI)? Does the stdlib do it? A native platform feature? Can it be one line? Build the minimum that works. No unrequested abstractions, no avoidable dependencies, no boilerplate. Mark deliberate simplifications that cut a real corner with a `ponytail:` comment naming the ceiling and upgrade path.

If args is empty, report the active level instead of switching.
