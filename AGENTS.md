# Switchboard agent instructions

## Product boundary

Switchboard is a focused VS Code sidebar for saving, starting, stopping, and opening local development projects. Keep it simple for nontechnical users.

- Implement exactly the requested GitHub issue and its acceptance criteria.
- Do not add adjacent features, speculative abstractions, dashboards, configuration systems, or new concepts.
- Prefer the smallest clear change that reuses existing code and UI patterns.
- Do not add a production dependency unless the issue cannot reasonably be completed without it.
- Preserve existing behavior unless the issue explicitly changes it.

## User experience

- Follow VS Code interface conventions and theme variables.
- Keep the sidebar readable and usable at narrow widths.
- Maintain keyboard, focus, and screen-reader behavior.
- Use plain language and avoid exposing implementation details to users.
- Update README wording only when user-visible behavior changes. Keep every claim accurate.

## Process and port safety

- Support Windows, macOS, and Linux.
- Treat configured ports as lightweight service metadata, not as a port-management system.
- Never terminate a process merely because it owns a configured port.
- Stop only the exact process tree Switchboard launched, unless the user supplied an explicit custom stop command.
- Preserve safe coordination across multiple VS Code windows.
- Be conservative when ownership or state is uncertain and explain failures clearly.

## Development workflow

- Work on one issue at a time.
- Read the complete issue before editing.
- Add focused regression coverage for changed behavior.
- Run `npm test`.
- Run `npm run package` before finishing.
- Review the complete diff for scope creep, regressions, accessibility, and cross-platform behavior.
- Do not change the extension version, GitHub release, changelog, or VSIX artifact unless the issue explicitly requires it.
- Do not merge into `main`, close issues, or publish releases. Leave a reviewable result with a concise summary, test evidence, and remaining risks.

## Code review rules

Flag consequential issues, especially:

- behavior outside the issue scope;
- unsafe process termination or port-owner assumptions;
- status that can become stale across VS Code windows;
- platform-specific shell, path, or process behavior;
- lost project data or incompatible persisted data;
- inaccessible controls, broken focus, or unusable narrow-sidebar layouts;
- user-facing claims that exceed shipped behavior.

Prefer concrete failures and safe alternatives over style-only feedback.
