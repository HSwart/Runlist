# Runlist lifecycle contract

This contract defines the safety outcomes Runlist must preserve across macOS,
Windows, Linux, Remote WSL workspace hosts, extension-host reloads, and multiple
VS Code windows. It is a release gate for lifecycle changes, not a description of
implementation details. Process identities, ownership tokens, and port
reservations are local to one extension host. A Windows host and a WSL Linux host
must never treat each other's PIDs as interchangeable.

## Invariants

1. **Reviewed setup only.** Runlist never executes an unreviewed project setup.
2. **One exact owner.** A launch is controlled by its ownership token, process
   identity, and recorded process tree. A PID by itself is never kill authority.
3. **Coordination survives the operation.** Process ownership and port
   reservations remain present until Runlist confirms the exact owned tree and
   configured services have stopped. Failed or uncertain cleanup retains enough
   state for safe recovery.
4. **Replacement processes are protected.** If an ownership token, PID identity,
   port generation, or listener identity changes during an operation, Runlist
   stops and leaves the replacement untouched.
5. **Descendants count.** A root process exit does not complete Stop while an
   owned descendant remains alive.
6. **Other processes are protected by default.** An externally occupied port
   blocks Start. Runlist may close the exact external listener only after explicit
   native confirmation and immediate identity revalidation.
7. **Temporary ports are launch-scoped.** Choosing a temporary port does not edit
   the saved project. The effective port is carried through environment,
   readiness, ownership, Stop, Restart, and recovery for that launch only.
8. **Cross-window actions are serialized.** At most one Start, Stop, Restart,
   handoff, detached cleanup, or custom Stop owns a project generation at a time.
9. **Status follows evidence.** `stopped` means no tracked process ownership or
   port reservation remains. Uncertain ownership is reported as unavailable, not
   silently converted to stopped.
10. **Unrelated processes survive.** Lifecycle operations never signal a process
    solely because it shares a command, name, folder, or configured port.

## Required release scenarios

| Scenario | Required outcome | Executable coverage |
| --- | --- | --- |
| Start, Restart, Stop | New generations replace old ones; the old tree is gone; final Stop clears coordination | Native lifecycle/adversarial smoke |
| Root exits with descendants | Descendants are verified and stopped before ownership is released | `project-process.test.js`, native adversarial smoke |
| Shell performs `exec` | Launch identity remains valid for the owned supervisor/tree | `project-process.test.js`, native adversarial smoke |
| PID or host PID is reused | No signal or stale-lock refresh occurs for the replacement | Native adversarial smoke, `project-process.test.js`, `port-gate.test.js`, `project-store.test.js` |
| Extension host reloads | Exact owned processes stop; custom Stop is honored; the next host observes stopped | Native setup/lifecycle smoke |
| Extension host crashes | Live targets remain protected under unavailable ownership and recover only after exact evidence changes | Native adversarial smoke, `project-process.test.js` |
| Two VS Code windows compete | One generation wins; stale cleanup cannot release replacement state | Native adversarial smoke, `project-process.test.js`, `port-gate.test.js`, `project-restart.test.js` |
| External listener blocks Start | Start is blocked and the listener remains alive without explicit confirmation | Native lifecycle smoke, `port-recovery.test.js` |
| External listener changes after confirmation | Operation aborts without signaling the replacement process | Native adversarial smoke, `port-recovery.test.js`, `port-process.test.js` |
| Temporary port is selected | Saved setup is unchanged, the launch generation owns the effective port, and Stop returns status to the untouched saved-port listener | Native lifecycle smoke, `service-port-overrides.test.js`, `service-port-management.test.js` |
| Custom Stop fails, hangs, or cannot prove completion | Runlist reports failure, cleans up its timed-out command tree, and retains uncertain project coordination | Native adversarial smoke, `project-restart.test.js`, `custom-stop-recovery.test.js` |
| Partial storage or lock update | State is recovered or retained fail-closed without deleting newer data | Native adversarial smoke, `project-store.test.js`, `project-process.test.js`, `port-gate.test.js` |
| Remote WSL workspace Start/Stop | Linux-folder projects use WSL loopback ports and the exact WSL process tree; Windows host PIDs and `\\wsl$` folders stay unsupported | `wsl-workspace-lifecycle.test.js`, `lifecycle-capability.test.js` |

The native smoke suite must assert process liveness, displayed status, process
ownership, and port reservations together. Unit tests remain responsible for
faults that cannot be induced safely in an extension-host run.
