# WinBoat development environment

A staged, Nix-defined workspace for Helios, WinBoat and their graphics, compute
and desktop dependencies. The target is one control plane usable by maintainers,
CI, Claude Code, Codex and other MCP clients, with reproducible source/tool pins
and a headless Windows development VM running the Helios QEMU fork.

**Stage 1 is implemented:** a locked shell, verified source pins, repository
sync, scoped checkpoints, verified push-to-pin updates, contributor forks and a
Node MCP control plane. Component builds and the Windows devbox follow in later
stages.

## Start here

Install Git, Nix and devenv using their official instructions; no distro or
system configuration is assumed. The scaffold was initialized with devenv
2.4.0. [devenv getting started](https://devenv.sh/getting-started/) describes
installation and shell commands.

```sh
devenv shell
wb setup
wb doctor --json
wb repo plan --subset helios
wb repo sync --subset helios --background --json
wb job status --id <returned-job-id> --json
wb repo branch --repo helios --name development
```

Use the committed lock; `devenv update` is an explicit dependency refresh. Use
`devenv shell -- wb ...` for noninteractive commands. Optional
[native activation](docs/auto-activation.md) uses `wb setup --activation <shell>`;
direnv-based editors/shells can use the tracked `.envrc` and `direnv allow`.
Shell entry does not clone repositories, commit files, start a VM or install a
driver.

All twelve declared objects were fetched from their canonical repositories and
synced at their exact pins, including DXIL-SPIRV and Venus. Source reachability
does not establish graphics/build compatibility. The locked CLI and modules use
unmodified upstream devenv. See [validation](docs/validation.md) for evidence
and the native Fish activation limitation for paths containing spaces.

## Implementation

The [stage index](docs/stages/README.md) lists dependencies, deliverables and
acceptance gates. Continue with [the Stage 2 handoff](docs/handoffs/stage-02.md).
[Workspace usage](docs/workspace.md) covers commands, publication recovery,
forks and MCP jobs.
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
