# WinBoat development environment

Read `README.md`, `docs/architecture.md`, `docs/repositories.md` and the active
stage in `docs/stages/README.md` before changing code. `CLAUDE.md` imports this
file. Environment/shared integration docs live here; component internals stay
in their repositories. Put personal machine notes in ignored `docs/user/`.

Use the locked devenv shell for execution. Initial Nix/devenv installation, Git
initialization and pure Nix checks are bootstrap exceptions. If inputs cannot be
fetched, report the blocked check; Nix parsing is not shell, build, VM or CI
validation. Do not manufacture lockfiles or source hashes.

The scaffold session authorizes the initial scaffold and its commit.
Implementation is split into later stages. Complete a requested stage through
its acceptance checks, and update the stage status and documentation.

Preserve unrelated changes and external reference checkouts. Inventory root and
nested Git status before edits and commits. Commit small, coherent, validated
checkpoints when the task authorizes commits. Stage task-owned paths only;
never blanket-stage managed repositories, personal config, guest state, keys or
media. Push only when requested. Publish dependencies before parents and pins
using the Stage 1 tool when available.

Discover the workspace and use local overrides instead of hardcoded host paths,
usernames, GPU nodes, bridges or binaries. Defined Windows guest defaults are
environment contracts, independent of the host. Declare execution in Nix,
including Windows payload dispatch. The Node MCP is a typed command proxy;
keep build/install logic in shared Nix-declared operations.

Distinguish desired, built, installed and loaded versions. Windows builds use a
local disk mirror and local `CARGO_TARGET_DIR`. Desktop probes require an
interactive session; installs use durable elevated tasks. A copy or reboot is
not proof that the requested driver or DLL is loaded.

Component build CI belongs in component repositories. This repository's release
CI verifies and bundles existing artifacts, including a prebuilt installer;
it never compiles component or installer binaries. Preserve license, provenance
and symbols through migration. Remove old installer, win-mcp and submodules
only after the replacement passes the migration gates.
