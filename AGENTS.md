# WinBoat development environment

Read `README.md`, `docs/architecture.md`, `docs/repositories.md` and the active
stage in `docs/stages/README.md` before changing code. `CLAUDE.md` imports this
file. Environment/shared integration docs live here; component internals stay
in their repositories. Put personal machine notes in ignored `docs/user/`.

Use WinBoat MCP tools by default for workspace, repository, build, devbox and
job operations. Discover the tools exposed in the current session. Use the
`wb` CLI for explicit CLI requests, CLI/shell integration checks or operations
without an MCP equivalent. If an expected MCP tool is missing or stale, inspect
the connection and report the limitation rather than silently bypassing it.

All execution uses the locked devenv environment. Assume Nix, devenv and native
auto-activation are already installed and configured; no direnv, `.envrc` or
host hook installation is needed. Run shell commands directly when native
activation or the generated Codex refresh supplies the environment. Use
`devenv shell -- <command>` only when that environment is absent, such as in CI.
Generate Codex settings with `wb-codex-config`; merge existing project settings
and restart Codex to load them. Its hook checks devenv's dependency cache before
each Bash command. Running commands and MCP servers retain their environment;
restart/reconnect the relevant server after Nix execution or MCP schema changes.
Initial Nix/devenv installation, Git initialization and pure Nix checks are
bootstrap exceptions. If inputs cannot be fetched, report the blocked check;
Nix parsing is not shell, build, VM or CI validation. Do not manufacture lockfiles
or source hashes.

Never read or modify devenv's internal state directory directly. Use its CLI;
project-owned state belongs under `.state/`. Declare development tools in Nix
and invoke them through the activated PATH or workspace commands. Use `git` on
PATH for ordinary Git operations; never bypass its workspace wrapper with an
absolute executable path.

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

Cross-compile Windows dependencies on the host wherever possible. Use the
Windows devbox for a build only when a concrete toolchain or component limitation
prevents cross-compilation; record that limitation. An MSVC ABI or static CRT
requirement alone does not require a Windows build host. Installation, signing
and loaded-state/runtime checks still use the Windows devbox as required.

Distinguish desired, built, installed and loaded versions. Windows builds use a
local disk mirror and local `CARGO_TARGET_DIR`. Desktop probes require an
interactive session; installs use durable elevated tasks. A copy or reboot is
not proof that the requested driver or DLL is loaded.

Component build CI belongs in component repositories. This repository's release
CI verifies and bundles existing artifacts, including a prebuilt installer;
it never compiles component or installer binaries. Preserve license, provenance
and symbols through migration. Remove old installer, win-mcp and submodules
only after the replacement passes the migration gates.
