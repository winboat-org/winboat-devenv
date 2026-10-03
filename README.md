# WinBoat development environment

A staged, Nix-defined workspace for Helios, WinBoat and their graphics, compute
and desktop dependencies. The target is one control plane usable by maintainers,
CI, Claude Code, Codex and other MCP clients, with reproducible source/tool pins
and a headless Windows development VM running the Helios QEMU fork.

**Stages 1–3 passed their measured native/cross and current-host devbox checks:**
repository/MCP operations, six composable component recipes, isolated native
graphics builds, a Windows DLL cross-build and immutable artifact manifests.
Component Windows MSVC/WDK builds await Stage 4. WinBoat/Electron/CLVK adapters expose
their remaining fixed dependency inputs; the Windows devbox is Stage 3. Stage 3's
host lifecycle, unmodified blank-disk creation, all 14 installed tools,
post-reboot autologin, signing/driver load and local mirror build checks passed.
NVIDIA devboxes now use Nix-pinned rootless Podman with workspace-private,
vendor-generated CDI. The host supplies its graphics driver and device access;
the workspace supplies the toolkit and hooks. See [devbox usage](docs/devbox.md)
and [validation](docs/validation.md) for runtime-specific checks and limits.

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

Stage 1 fetched all twelve seed objects from canonical repositories. Stage 2
adds local recipe commits and coherent parent/child pins, verified through
ignored local remote overrides. Those new commits have not been published;
canonical reachability remains pending. The locked CLI and modules use
unmodified upstream devenv. See [validation](docs/validation.md) for measured
build checks and the native Fish activation limitation for paths with spaces.

## Implementation

The [stage index](docs/stages/README.md) lists dependencies, deliverables and
acceptance gates. Continue with [the Stage 4 handoff](docs/handoffs/stage-04.md).
[Workspace usage](docs/workspace.md) covers commands, publication recovery,
forks and MCP jobs.
[Build usage](docs/builds.md) covers target selection, source modes, guest
dispatch plans and artifact/closure verification.
[Devbox usage](docs/devbox.md) covers exact artifact selection, persistent state,
the attachable VNC viewer, automatic desktop login and offline toolchain.
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
