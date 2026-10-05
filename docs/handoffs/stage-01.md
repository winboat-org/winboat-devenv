# Stage 1 handoff prompt

Paste the following into the next session, opened in this repository:

```text
Implement Stage 1 of winboat-devenv through its acceptance gates.

Read AGENTS.md, README.md, docs/architecture.md, docs/repositories.md,
docs/reference-audit.md, docs/stages/README.md and
docs/stages/01-workspace.md, plus docs/auto-activation.md. Inspect Git status
and preserve unrelated work.

The scaffold was initialized with devenv 2.4.0. Nix manifest validation passed,
but input fetching and the live devenv shell were blocked by session networking.
Generate and commit a genuine devenv.lock. Resolve the two null source pins
(WBFreeRDP and Electron), discover development refs, and verify all ten seeded
SHAs at their canonical organization URLs. Do not substitute floating HEAD for
a paired graphics pin or claim the seeds represent a validated stack.

Implement the repo-like tool in Nix with setup/doctor, list/status/plan/sync,
single-repo and helios/winboat/winboat-accel/all selectors, explicit checkpoints,
pin updates, fork mode and Git push interception scoped to the Nix environment.
Assume Nix, devenv and native auto-activation are already installed and configured.
Setup prepares workspace configuration/state only; do not inspect or modify
host shell startup files. Use native hooks without .envrc or direnv, and leave
checkout trust to devenv. Do not build an interactive activation test harness.
Use the manifest's dependency closure and current nested layout. Include the
managed DXIL-SPIRV/Venus dependencies. Never recursively sync all QEMU submodules.
The requested Venus-in-Mesa layout is a later migration; preserve current
gitlink/pin consistency until the build consumers migrate together.

Preserve dirty/index/conflict state. A successful managed push must record the
actual remotely verified pushed commit, atomically update only its pin entries,
and create a scoped checkpoint without consuming unrelated staged files.
Failed/dry-run/tag/delete/unselected pushes cannot advance pins. Make partial
post-push failures recoverable with durable receipts and reconciliation.
Fork mode scopes origin changes to the contributor namespace and preserves
winboat-org upstream, exact pins and local work without global Git/SSH edits.

Expose this control plane through a minimal Node stdio MCP that proxies the
same Nix commands, with typed arguments, JSON results and durable long-job IDs.
Update real client launch configs only after the server initializes correctly.
All routine execution should use the locked Nix environment; do not duplicate
repo logic in MCP. Use local bare-repository fixtures to verify push semantics,
dirty-state preservation, submodule scope, forks and injected recovery failures.

Clone references into ignored workspace locations if useful. The supplied
Helios checkout (configure its actual location locally) is read-only reference
material for this stage. Keep implementation in this repo and managed test
checkouts. Do not provision Windows, compile components, remove old win-mcp or
submodules, or publish changes to GitHub in this stage.

Commit coherent validated checkpoints and the completed Stage 1 changes locally;
do not push. Update stage status/docs, report exact validation and any blocked
live checks, and provide a Stage 2 handoff. Continue through implementation and
validation rather than stopping at a proposed plan.
```
