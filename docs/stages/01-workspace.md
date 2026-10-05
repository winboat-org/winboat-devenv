# Stage 1 — Workspace and repository control plane

Status: implemented; repository/MCP acceptance passed. Prerequisite: Stage 0.
No VM or component changes were made. See [validation](../validation.md) and
[workspace usage](../workspace.md). Interactive activation test coverage was
excluded at the maintainer's request; native hooks use unmodified upstream
devenv, with its Fish path-with-spaces limitation documented. Automatic activation
uses native hooks only; the duplicate direnv path and dependency were removed.
Nix, devenv and native auto-activation are preconfigured prerequisites; shell
hook installation and diagnostics have been removed from setup/doctor.

## Outcome

A contributor enters a locked Nix environment, inspects a sync plan, reproduces
a selected source snapshot, creates scoped checkpoints, switches to their fork,
and pushes through Git with verified pin updates. The same operations are
available through a minimal Node MCP control-plane server.

## Implementation

1. Generate and commit `devenv.lock`; pin the supported devenv CLI/modules and
   host tools. Resolve WBFreeRDP/Electron revisions and discover development refs
   for all repositories. Verify every seeded object exists at its canonical URL;
   preserve paired graphics pins and parent gitlinks. Record remote verification
   separately from seed provenance. The complete Helios subset should work
   independently of unresolved repositories outside its closure.
2. Implement configuration schema/precedence and discovery. `wb setup` prepares
   ignored state/config idempotently, with no implicit clone or VM start.
   `wb doctor` reports tools, pin reachability, checkout state, capabilities and
   remedies in human/JSON output. Assume Nix, devenv and native auto-activation
   are installed and configured. Setup prepares workspace state only; do not
   inspect or modify host shell configuration. Use native hooks without `.envrc`
   or direnv. See `docs/auto-activation.md`. Paths with
   spaces and arbitrary host usernames
   must work. Adopt an external checkout only by explicit local configuration;
   validate ownership/remotes/layout and preserve its working/index state.
3. Declare the repo-like tool **in Nix**, e.g. `nix/commands/repos.nix` using
   `writeShellApplication` and pinned dependencies. Implement `wb repo list`,
   `status`, `plan`, `sync`, `pin`, `checkpoint`, `push` and `fork`. Both subset
   selection and repeated `--repo <id>` must work; compute dependency closure
   once from the Nix manifest, and provide necessary parent containers without
   syncing unselected siblings. `all` means the complete inventory.
4. Sync exact revisions, not moving refs. A normal checkout may start detached;
   provide a clear command to create a development branch. Initialize only
   selected submodule paths at pinned gitlinks. QEMU has no initial submodule
   allowlist; never use a blanket recursive update on it. Validate pins against
   parent gitlinks before fetching/mutating; inconsistent pins require an
   explicit coherent update. Preserve dirty, staged, untracked and conflicted
   state; fail an affected sync with useful diagnostics instead of reset/clean/
   stash. Planning must show scope and all intended writes.
5. Implement checkpoint automation. Commit selected staged/task-owned source
   changes in dependency order; update authorized parent gitlinks and then the
   root pin checkpoint. Support a message and explicit path scope. Automatic
   post-push pin checkpoints touch only this operation's pin entries; do not
   consume a contributor's existing staged changes. Pin auto-commit is the
   normal managed push behavior, with an explicit deferred-checkpoint mode for
   an ongoing parent publication transaction. No prompts at routine authorized
   checkpoints. Plain sync and shell entry never silently commit source edits.
6. Intercept `git push` inside the Nix environment using a wrapper backed by
   the absolute pinned Git executable. Preserve `git -C`, `-c`, worktree/git-dir
   options, arguments and normal non-push behavior. Verify the actual pushed
   remote ref/commit **after success** before advancing its pin. Handle explicit
   refspecs, multiple refs, `--all`, `--mirror`, alternate push URLs, no-op pushes,
   detached HEAD and `--force-with-lease` conservatively. Dry runs, tags, deletes,
   unselected refs, failures and pushes outside managed repos never advance
   pins. Reject ambiguous managed pin effects during preflight with a useful
   explicit `wb repo push` alternative, instead of pretending any Git success
   equals a pin update. Absolute Git paths can bypass PATH interception; report
   that limitation and configure supported clients to use the wrapper.
7. Journal repository/push transactions and serialize root pin writers. Capture
   expected old pins, remote/ref and exact pushed SHA; write Nix data atomically
   without evaluating arbitrary contributor text. If the remote push succeeds
   but local pin/commit work fails, preserve that fact and a recoverable receipt,
   return an actionable partial-completion error, and support reconciliation
   without repeating the push. Track which parent gitlinks still need publishing.
   Do not claim distributed Git pushes are atomic or roll them back implicitly.
8. Fork mode validates the namespace and fork access, plans remotes, changes
   selected `origin` URLs, retains winboat-org `upstream` and preserves refs/pins.
   Missing forks receive an explicit creation path; if implementing GitHub fork
   creation, make it an explicit command. Leave global Git/SSH config untouched.
   Handle nested submodule URL overrides locally; `.gitmodules` changes are an
   explicit shared change. Keep canonical pins upstream by default; fork-specific
   URL/revision updates are explicit and reproducible.
9. Add a minimal Node stdio MCP exposing workspace status and the repo operations
   through the same Nix commands. Validate typed selectors/arguments; use spawn
   argument arrays, stderr diagnostics and JSON receipts. Durable job IDs handle
   long syncs and publication; disconnect must not corrupt transactions. Add
   project launch configuration only after the server starts and lists tools.

## Acceptance

Use local bare Git repositories/fixtures for meaningful integration tests;
network access and publishing the real organization repos are not prerequisites
for testing wrapper semantics. Test single/all/subset selection, dependency
closure, parent placement, selective submodules, dirty/index/conflict protection,
fork remotes and no mutation on shell entry. Compare preserved file/index hashes.

Native activation and checkout trust remain upstream behavior, outside
workspace setup/doctor. Existing host shell configuration is assumed ready.
Per the maintainer's validation scope, do not maintain a PTY
activation regression suite or patch devenv to satisfy one. Agents use the
advertised WinBoat MCP tools for routine operations. CLI/shell integration
checks run directly in the activated or refreshed environment; noninteractive
execution without that environment enters the locked shell explicitly.

Exercise ordinary Git delegation and actual successful/failed/dry-run/no-op/
explicit-refspec pushes. Confirm a successful managed push records its remote
commit even when it differs from checkout HEAD; failed/unselected/tag/delete
pushes leave pins unchanged. Inject a pin-write failure after successful push,
then reconcile it. Test concurrent pin updates and an unrelated dirty root/index.

Run `devenv test`; confirm a clean source workspace can sync the declared pins,
including DXIL-SPIRV/Venus, without fetching all QEMU submodules. MCP initialize,
tools/list and representative status/sync/fork/checkpoint operations must match
CLI results and propagate failure. Record any live remote checks that remain
unavailable. Update README, config documentation, pin provenance and stage status.

## Boundary

Do not provision Windows, compile components, push organization changes, delete
Helios submodules or replace the existing win-mcp in this stage. Clone references
into ignored locations if useful; do not edit the supplied reference checkout.
