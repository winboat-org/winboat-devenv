# WinBoat development environment

A staged, Nix-defined workspace for Helios, WinBoat and their graphics, compute
and desktop dependencies. The target is one control plane usable by maintainers,
CI, Claude Code, Codex and other MCP clients, with reproducible source/tool pins
and a headless Windows development VM running the Helios QEMU fork.

This is the **initial scaffold**: repository inventory and seed pins, a devenv
shell definition, agent guidance/configuration samples and implementation
contracts. Sync, Git push interception, fork mode, builds, the Windows devbox
and the Node control plane are implemented in later stages.

## Start here

Install Git, Nix and devenv using their official instructions; no distro or
system configuration is assumed. The scaffold was initialized with devenv
2.4.0. [devenv getting started](https://devenv.sh/getting-started/) describes
installation and shell commands.

Set up [automatic activation](docs/auto-activation.md) once for your shell. For
Bash, load `eval "$(devenv hook bash)"` in your shell startup configuration and
run `devenv allow` from this workspace. Entering/leaving the workspace then
activates/deactivates its environment. Zsh, Fish and Nushell instructions and
tracked shell fragments are included.

```sh
devenv update                     # Generate/refresh and review devenv.lock.
devenv shell
wb-plan
wb-check                         # Structural checks, allowing unresolved seeds.
wb-pins helios                   # Includes dxil-spirv and venus-protocol.
wb-pins winboat
wb-check --ready                 # Requires all 12 source pins and devenv.lock.
```

Or use `devenv shell -- wb-check` without an interactive shell. Direnv-based
editors/shells can use the tracked `.envrc` and `direnv allow`.
Shell entry does not clone repositories, commit files, start a VM or install a
driver. The scaffold commands are read-only.

The initial session could not fetch Nix inputs or remote Git refs. **devenv.lock
is not generated yet**, and the shell has not been built or entered. Ten source
revisions are seeded from current local reference metadata; WBFreeRDP and
Electron are explicitly unresolved. Stage 1 must produce the Nix lock and verify
source accessibility before claiming a reproducible workspace. Pure Nix checks
can run now; see [Nix ownership](nix/README.md).

## Implementation

The [stage index](docs/stages/README.md) lists dependencies, deliverables and
acceptance gates. Start the next session with [the Stage 1 handoff](docs/handoffs/stage-01.md).
[Architecture](docs/architecture.md) defines the shared CLI/MCP, devbox and
artifact contracts. [Repository policy](docs/repositories.md) describes subsets,
pins and the current nested layout.

Environment and shared integration docs live in [docs/](docs/README.md).
Personal machine notes live in ignored [docs/user/](docs/user/README.md).
[Reference audit](docs/reference-audit.md) records the existing tooling.
[Configuration](config/README.md) describes local settings and agent templates;
no machine-specific paths or credentials are committed.

Component recipes belong in the six Helios repositories; other recipes belong
here. Component CI builds individual artifacts. This repository's release CI
only verifies and bundles existing artifacts and a prebuilt installer.
User-supplied Windows media and generated guest credentials remain local.
